/**
 * Generic OAuth auth configuration resolver.
 *
 * Turns a declarative `[auth]` config section (master switch + a `providers` table)
 * into the {@link OAuthProviderConfig} array consumed by {@link createOAuthProvider},
 * plus the resolved `enabled` flag and `/mcp` enforcement metadata. This is the
 * reusable half of OAuth setup: any MCP server can describe its providers in config
 * and call {@link resolveAuthConfig} — only the per-provider userinfo→identity mapping
 * (`mapUserInfo` / `onTokenExchanged`) stays application-specific.
 *
 * Provider source-of-truth is the framework's own `[auth]` config-file section
 * (retained via {@link getRawAuthConfig}); the master switch additionally honours the
 * `MCP_AUTH_ENABLED` environment variable (or `.env` file, resolved via
 * {@link getFrameworkConfig}). Consumers that carry legacy/env-branded provider
 * configs can map them to {@link AuthProviderInput} and feed
 * {@link toOAuthProviderConfigs} directly.
 *
 * @module server/auth/auth-config
 */

import { getRawAuthConfig, getFrameworkConfig } from "../../config/config-cache.js";
import { logger as baseLogger } from "../../logger/index.js";
import type { OAuthProviderConfig } from "./oauth/index.js";

const logger = baseLogger.child({ component: "auth-config" });

/**
 * Declarative, transport-agnostic description of one upstream OAuth provider.
 *
 * Field aliases mirror common IdP/config conventions: `id`/`client_id`/`clientId`
 * and `secret`/`client_secret`/`clientSecret` are all accepted. `type` may be omitted
 * when the routing name is a known preset (`google`, `github`); anything else is `oidc`
 * and requires an `issuer`.
 */
export interface AuthProviderInput {
  /** Whether the provider is active. Treated as `true` when omitted. */
  readonly enabled?: boolean | undefined;
  /** Provider kind. Inferred from the routing name when omitted. */
  readonly type?: "google" | "github" | "oidc" | undefined;
  /** OAuth client ID (alias of `client_id` / `clientId`). */
  readonly id?: string | undefined;
  readonly client_id?: string | undefined;
  readonly clientId?: string | undefined;
  /** OAuth client secret (alias of `client_secret` / `clientSecret`). */
  readonly secret?: string | undefined;
  readonly client_secret?: string | undefined;
  readonly clientSecret?: string | undefined;
  /** OIDC issuer URL (required for `oidc`; optional override for `google`). */
  readonly issuer?: string | undefined;
  /** Requested upstream scopes. */
  readonly scopes?: readonly string[] | undefined;
}

/** Resolved auth configuration ready to drive `createOAuthProvider` + middleware. */
export interface ResolvedAuthConfig {
  /** Whether MCP-server user authentication is active. */
  readonly enabled: boolean;
  /** Fully-formed provider configs (only complete, enabled providers). */
  readonly providers: OAuthProviderConfig[];
  /** Required scopes for the `/mcp` endpoint, when configured. */
  readonly requiredScopes?: string[] | undefined;
  /** Protected Resource Metadata URL (RFC 9728), when configured. */
  readonly resourceMetadataUrl?: string | undefined;
}

/** Infer a provider kind from its routing name. Unknown names are treated as generic OIDC. */
function inferProviderType(name: string): "google" | "github" | "oidc" {
  const n = name.toLowerCase();
  if (n === "google") return "google";
  if (n === "github") return "github";
  return "oidc";
}

/**
 * Map a declarative `{ name → provider }` table to {@link OAuthProviderConfig}s.
 *
 * Skips providers that are explicitly disabled or have no credentials at all (an
 * empty stub). A provider that is enabled but only *partially* configured (missing
 * one of clientId/clientSecret, or an `oidc`/non-preset provider missing its issuer)
 * is skipped with a warning so the misconfiguration is visible without crashing startup.
 *
 * @param providers - Provider table keyed by routing name, or `undefined`
 * @returns Provider configs in declaration order
 */
export function toOAuthProviderConfigs(
  providers: Readonly<Record<string, AuthProviderInput>> | undefined,
): OAuthProviderConfig[] {
  if (!providers) return [];

  const result: OAuthProviderConfig[] = [];

  for (const [name, p] of Object.entries(providers)) {
    if (p.enabled === false) continue;

    const clientId = p.clientId ?? p.client_id ?? p.id;
    const clientSecret = p.clientSecret ?? p.client_secret ?? p.secret;
    const type = p.type ?? inferProviderType(name);

    // No credentials at all → treat as an unconfigured stub, silently skip.
    if (!clientId && !clientSecret && !p.issuer) continue;

    if (!clientId || !clientSecret) {
      logger.warn('Auth provider "%s" is enabled but missing client id/secret — skipping', name);
      continue;
    }

    const scopes = p.scopes && p.scopes.length > 0 ? [...p.scopes] : undefined;

    if (type === "github") {
      result.push({ type: "github", clientId, clientSecret, ...(scopes && { scopes }) });
    } else if (type === "google") {
      result.push({
        type: "google",
        clientId,
        clientSecret,
        ...(p.issuer && { issuer: p.issuer }),
        ...(scopes && { scopes }),
      });
    } else {
      if (!p.issuer) {
        logger.warn('OIDC auth provider "%s" is missing an issuer URL — skipping', name);
        continue;
      }
      result.push({ type: "oidc", clientId, clientSecret, issuer: p.issuer, ...(scopes && { scopes }) });
    }
  }

  return result;
}

/**
 * Resolve the framework `[auth]` config section into a {@link ResolvedAuthConfig}.
 *
 * The master switch precedence is: `MCP_AUTH_ENABLED` (env var, or `.env` file via
 * {@link getFrameworkConfig}) → `[auth].enabled` file flag → `options.defaultEnabled`,
 * falling back to "enabled when at least one provider is configured" when
 * `defaultEnabled` is omitted. Providers come from the `[auth.providers.*]` tables.
 *
 * @param options.defaultEnabled - Overrides the final fallback used when neither the
 *   env var nor the config file set `enabled` explicitly. Omit to keep the framework's
 *   generic default (on only when a provider is configured). Pass `true` for consumers
 *   that always offer a non-provider login method (e.g. local username/password), for
 *   which "no providers configured" doesn't mean "no way to log in".
 * @returns The resolved auth configuration
 */
export function resolveAuthConfig(options?: { readonly defaultEnabled?: boolean }): ResolvedAuthConfig {
  const raw = getRawAuthConfig();
  const providers = toOAuthProviderConfigs(raw?.providers);

  const envEnabled = getFrameworkConfig().MCP_AUTH_ENABLED;
  const fallback = options?.defaultEnabled ?? providers.length > 0;
  const enabled = envEnabled ?? raw?.enabled ?? fallback;

  return {
    enabled,
    providers,
    ...(raw?.required_scopes && raw.required_scopes.length > 0 && { requiredScopes: [...raw.required_scopes] }),
    ...(raw?.resource_metadata_url && { resourceMetadataUrl: raw.resource_metadata_url }),
  };
}
