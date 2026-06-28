/**
 * OAuth Provider Factory — the single public entry point.
 *
 * {@link createOAuthProvider} accepts one provider config or an array and builds a
 * server-side callback {@link OAuthProviderResult}. Built-in providers (`github`,
 * `google`, `oidc`) are resolved via {@link OAUTH_PRESETS}; `oauth2` is the explicit-
 * endpoint escape hatch. OIDC/Google endpoints are auto-discovered. All configs are
 * resolved into {@link ResolvedProvider} objects and handed to the protocol engine
 * {@link createOAuthProviderCore} in `./core.ts`.
 *
 * - 1 provider  → the user is redirected directly to the upstream.
 * - N providers → `GET /authorize` renders a provider-selection page.
 *
 * @example single OIDC provider
 * ```typescript
 * const { provider, callbackHandler } = await createOAuthProvider(
 *   { type: 'oidc', issuer: 'https://auth.example.com', clientId, clientSecret },
 *   { serverUrl: 'http://localhost:8000' },
 * );
 * ```
 *
 * @example multiple providers with selection page
 * ```typescript
 * const { provider, callbackHandler } = await createOAuthProvider(
 *   [
 *     { type: 'github', clientId: GH_ID, clientSecret: GH_SECRET },
 *     { type: 'google', clientId: G_ID, clientSecret: G_SECRET },
 *   ],
 *   { serverUrl: 'http://localhost:8000' },
 * );
 * ```
 *
 * @module server/auth/oauth/provider
 */

import { createOAuthProviderCore } from "./core.js";
import type {
  BoundMapUserInfo,
  MapUserInfo,
  OAuthProviderCoreOptions,
  OAuthProviderResult,
  OnTokenExchanged,
  ProviderContext,
  ResolvedProvider,
  UpstreamEndpoints,
} from "./core.js";
import { OAUTH_PRESETS } from "./presets.js";
import { resolveOidcEndpoints } from "./discovery.js";
import { stripTrailingSlashes } from "../../../utils/string-helpers.js";
import { logger as baseLogger } from "../../../logger/index.js";

// Re-export the public engine types so consumers import everything from the factory module.
export type {
  OAuthProviderType,
  ProviderContext,
  MapUserInfo,
  OnTokenExchanged,
  OAuthProviderResult,
  UpstreamEndpoints,
} from "./core.js";
export { authInfoExpiry } from "./core.js";

const logger = baseLogger.child({ component: "oauth-provider" });

// ============================================================================
// Public Config Types
// ============================================================================

/** Fields common to every provider config. */
interface OAuthProviderConfigBase {
  /** Client ID registered with the upstream provider. */
  readonly clientId: string;
  /** Client secret registered with the upstream provider. */
  readonly clientSecret: string;
  /** Override the default OAuth scopes requested from the upstream provider. */
  readonly scopes?: readonly string[];
  /** Display name shown on the selection page. Defaults to the preset's display name. */
  readonly displayName?: string;
  /**
   * Per-provider userinfo mapper. Highest precedence — overrides the global
   * `options.mapUserInfo` and the preset default for this provider only.
   */
  readonly mapUserInfo?: MapUserInfo;
}

/** GitHub OAuth (known endpoints, JSON token endpoint). */
export interface GithubProviderConfig extends OAuthProviderConfigBase {
  readonly type: "github";
}

/** Google OIDC (auto-discovery; issuer defaults to `https://accounts.google.com`). */
export interface GoogleProviderConfig extends OAuthProviderConfigBase {
  readonly type: "google";
  /** Override the Google issuer. */
  readonly issuer?: string;
}

/** Generic OIDC provider with automatic endpoint discovery. */
export interface OidcProviderConfig extends OAuthProviderConfigBase {
  readonly type: "oidc";
  /** OIDC issuer URL — discovery document is fetched from `{issuer}/.well-known/openid-configuration`. */
  readonly issuer: string;
  /**
   * MCP scopes granted to authenticated users by the default mapper.
   * Ignored when a custom `mapUserInfo` is supplied.
   */
  readonly grantedScopes?: readonly string[];
}

/**
 * Explicit-endpoint provider — the escape hatch for any OAuth2 server that is not
 * OIDC-compliant (no discovery document). You provide the endpoints and a `mapUserInfo`.
 */
export interface OAuth2ProviderConfig extends OAuthProviderConfigBase {
  readonly type: "oauth2";
  /** Unique routing key (also the selection-page `?provider=` value). Required — there is no preset to derive it. */
  readonly name: string;
  /** Upstream OAuth endpoint URLs. */
  readonly endpoints: UpstreamEndpoints;
  /**
   * Content type for the token exchange request.
   * @default 'form'
   */
  readonly tokenRequestContentType?: "form" | "json";
  /**
   * Whether the upstream supports refresh tokens (single-provider only).
   * @default false
   */
  readonly refreshTokenSupport?: boolean;
  /**
   * Extra query parameters appended to the upstream authorization URL.
   * Standard params (`client_id`, `redirect_uri`, `state`, `scope`) are set automatically.
   */
  readonly upstreamAuthorizeParams?: Readonly<Record<string, string>>;
  /** Required: there is no preset mapper for a custom OAuth2 provider. */
  readonly mapUserInfo: MapUserInfo;
}

/** Discriminated union of all provider configurations accepted by {@link createOAuthProvider}. */
export type OAuthProviderConfig =
  | GithubProviderConfig
  | GoogleProviderConfig
  | OidcProviderConfig
  | OAuth2ProviderConfig;

/** A preset-backed config (everything except the explicit-endpoint `oauth2`). */
type PresetProviderConfig = GithubProviderConfig | GoogleProviderConfig | OidcProviderConfig;

/** Options for {@link createOAuthProvider}. */
export interface CreateOAuthProviderOptions {
  /** MCP server base URL (e.g. `http://localhost:8000`). `/callback` is appended internally. */
  readonly serverUrl: string;

  /**
   * Global side-effect hook fired after every upstream token exchange.
   * Receives the {@link ProviderContext}, upstream access token, and raw token response.
   */
  readonly onTokenExchanged?: OnTokenExchanged;

  /**
   * Global userinfo mapper. Used for any provider that has no own `mapUserInfo`.
   * Lower precedence than a per-provider mapper, higher than the preset default.
   */
  readonly mapUserInfo?: MapUserInfo;

  /** TTL for the cached OIDC discovery document(s), in milliseconds. @default 3600000 (1 hour) */
  readonly discoveryTtlMs?: number;

  // ── timing / capacity ──
  readonly pendingAuthTtlMs?: number;
  readonly codeContextTtlMs?: number;
  readonly tokenTtlMs?: number;
  readonly maxClients?: number;
  readonly maxPendingAuths?: number;
  readonly maxTokens?: number;
}

// ============================================================================
// Resolution
// ============================================================================

/** Binds a {@link ProviderContext} into the effective userinfo mapper for a provider. */
function resolveMapUserInfo(
  cfg: OAuthProviderConfig,
  options: CreateOAuthProviderOptions,
  ctx: ProviderContext,
  buildDefault: () => BoundMapUserInfo,
): BoundMapUserInfo {
  const override = cfg.mapUserInfo ?? options.mapUserInfo;
  return override ? (token, data) => override(ctx, token, data) : buildDefault();
}

/** Resolves a preset-backed provider (github / google / oidc). */
async function resolvePresetProvider(
  cfg: PresetProviderConfig,
  options: CreateOAuthProviderOptions,
): Promise<ResolvedProvider> {
  const preset = OAUTH_PRESETS[cfg.type];

  let issuer: string | undefined;
  let endpoints: UpstreamEndpoints;

  if (preset.resolution.kind === "static") {
    endpoints = preset.resolution.endpoints;
  } else {
    // google | oidc — discover endpoints from the issuer
    const explicitIssuer = cfg.type === "github" ? undefined : cfg.issuer;
    issuer = explicitIssuer ?? preset.resolution.defaultIssuer;
    if (!issuer) {
      throw new Error(`createOAuthProvider: '${cfg.type}' provider requires an issuer URL`);
    }
    logger.info("Resolving %s provider via OIDC discovery (issuer %s)", cfg.type, issuer);
    const ep = await resolveOidcEndpoints(issuer, options.discoveryTtlMs);
    endpoints = {
      authorizationUrl: ep.authorizationUrl,
      tokenUrl: ep.tokenUrl,
      ...(ep.userinfoUrl !== undefined && { userinfoUrl: ep.userinfoUrl }),
      ...(ep.revocationUrl !== undefined && { revocationUrl: ep.revocationUrl }),
    };
    if (!endpoints.userinfoUrl) {
      logger.warn("OIDC discovery for %s has no userinfo_endpoint — token verification may fail", issuer);
    }
  }

  const name = cfg.type === "oidc" ? `oidc:${issuer}` : cfg.type;
  const ctx: ProviderContext = { type: cfg.type, name, ...(issuer !== undefined && { issuer }) };
  const grantedScopes = cfg.type === "oidc" ? cfg.grantedScopes : undefined;

  const mapUserInfo = resolveMapUserInfo(cfg, options, ctx, () =>
    preset.buildDefaultMapUserInfo({
      ...(issuer !== undefined && { issuer }),
      ...(grantedScopes !== undefined && { grantedScopes }),
    }),
  );

  return {
    ctx,
    displayName: cfg.displayName ?? preset.defaultDisplayName,
    endpoints,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    scopes: [...(cfg.scopes ?? preset.defaultScopes)],
    tokenRequestContentType: preset.tokenRequestContentType,
    ...(preset.upstreamAuthorizeParams !== undefined && { upstreamAuthorizeParams: preset.upstreamAuthorizeParams }),
    refreshTokenSupport: preset.refreshTokenSupport,
    mapUserInfo,
  };
}

/** Resolves an explicit-endpoint (`oauth2`) provider. */
function resolveOAuth2Provider(cfg: OAuth2ProviderConfig, options: CreateOAuthProviderOptions): ResolvedProvider {
  const ctx: ProviderContext = { type: "oauth2", name: cfg.name };
  // `cfg.mapUserInfo` is required by the type, so the override is always defined.
  const mapUserInfo = resolveMapUserInfo(cfg, options, ctx, () => {
    throw new Error(`createOAuthProvider: 'oauth2' provider '${cfg.name}' requires a mapUserInfo`);
  });

  return {
    ctx,
    displayName: cfg.displayName ?? cfg.name,
    endpoints: cfg.endpoints,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    scopes: [...(cfg.scopes ?? [])],
    tokenRequestContentType: cfg.tokenRequestContentType ?? "form",
    ...(cfg.upstreamAuthorizeParams !== undefined && { upstreamAuthorizeParams: cfg.upstreamAuthorizeParams }),
    refreshTokenSupport: cfg.refreshTokenSupport ?? false,
    mapUserInfo,
  };
}

async function resolveProvider(
  cfg: OAuthProviderConfig,
  options: CreateOAuthProviderOptions,
): Promise<ResolvedProvider> {
  return cfg.type === "oauth2" ? resolveOAuth2Provider(cfg, options) : resolvePresetProvider(cfg, options);
}

// ============================================================================
// Public Factory
// ============================================================================

/**
 * Creates an {@link OAuthProviderResult} that proxies OAuth flows to one or more
 * upstream authorization servers using the server-side callback pattern.
 *
 * Always async — OIDC/Google providers fetch their discovery document at creation time.
 *
 * @param providers - A single provider config or an array of them
 * @param options - Server URL, hooks, and timing/capacity overrides
 * @returns Provider, callback handler, and dispose function
 */
export async function createOAuthProvider(
  providers: OAuthProviderConfig | readonly OAuthProviderConfig[],
  options: CreateOAuthProviderOptions,
): Promise<OAuthProviderResult> {
  const configs: readonly OAuthProviderConfig[] = Array.isArray(providers) ? providers : [providers];
  if (configs.length === 0) {
    throw new Error("createOAuthProvider: at least one provider config is required");
  }

  const serverCallbackUrl = `${stripTrailingSlashes(options.serverUrl)}/callback`;

  const resolved: ResolvedProvider[] = [];
  const seenNames = new Set<string>();
  for (const cfg of configs) {
    const provider = await resolveProvider(cfg, options);
    if (seenNames.has(provider.ctx.name)) {
      throw new Error(
        `createOAuthProvider: duplicate provider name '${provider.ctx.name}' — provider names must be unique`,
      );
    }
    seenNames.add(provider.ctx.name);
    resolved.push(provider);
  }

  const coreOptions: OAuthProviderCoreOptions = {
    ...(options.onTokenExchanged !== undefined && { onTokenExchanged: options.onTokenExchanged }),
    ...(options.pendingAuthTtlMs !== undefined && { pendingAuthTtlMs: options.pendingAuthTtlMs }),
    ...(options.codeContextTtlMs !== undefined && { codeContextTtlMs: options.codeContextTtlMs }),
    ...(options.tokenTtlMs !== undefined && { tokenTtlMs: options.tokenTtlMs }),
    ...(options.maxClients !== undefined && { maxClients: options.maxClients }),
    ...(options.maxPendingAuths !== undefined && { maxPendingAuths: options.maxPendingAuths }),
    ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
  };

  return createOAuthProviderCore(serverCallbackUrl, resolved, coreOptions);
}
