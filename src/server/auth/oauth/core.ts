/**
 * OAuth Provider Core — the server-side callback engine.
 *
 * Implements the server-side callback pattern: the MCP server proxies OAuth flows
 * to one or more upstream authorization servers, intercepting callbacks and mapping
 * upstream tokens to MCP client sessions. A single callback URL serves 1..N upstream
 * providers; when more than one is configured a provider-selection page is rendered.
 *
 * This module is the protocol engine only. Provider configuration (presets, OIDC
 * discovery, the public {@link createOAuthProvider} factory) lives in `./provider.ts`.
 * Upstream provider factories resolve their configuration into {@link ResolvedProvider}
 * objects and hand them to {@link createOAuthProviderCore}.
 *
 * Flow (server-side callback):
 *   Client → MCP /authorize → Upstream /authorize  (redirect_uri = MCP /callback)
 *   Upstream → MCP /callback?code=UPSTREAM_CODE&state=UPSTREAM_STATE
 *   MCP generates UUID code, stores {provider, upstreamCode} in codeContexts
 *   MCP → Client callback?code=OUR_CODE&state=CLIENT_STATE
 *   Client → MCP /token?code=OUR_CODE
 *   MCP exchanges OUR_CODE → upstream token, registers in tokenRegistry for routing
 *
 * @module server/auth/oauth/core
 */

import crypto from "node:crypto";
import type { Request, Response, RequestHandler } from "express";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { renderSelectionPage } from "../login.js";
import { logger as baseLogger } from "../../../logger/index.js";
import {
  assertJsonContentType,
  fetchToken,
  OAUTH_FETCH_TIMEOUT_MS,
  parseClientRedirectUri,
  parseTokenResponse,
} from "./http.js";
import { BoundedMap } from "./state.js";

// ============================================================================
// Logger
// ============================================================================

const LogMessages = {
  GET_CLIENT: "getClient: %s → %s",
  REGISTERED_CLIENT: "Registered client: %s",
  CLIENT_EVICTED: "Client store at capacity (%d) — evicted oldest client: %s",
  AUTHORIZE: "Authorize: client=%s provider=%s upstreamState=%s",
  TOKEN_EXCHANGE: "Token exchange: provider=%s code=%s…",
  CALLBACK_INVALID_STATE: "Callback: invalid or expired state=%s",
  CALLBACK_EXPIRED: "Callback: expired pending auth state=%s",
  CALLBACK_SUCCESS: "Callback: provider=%s state mapped, redirecting to client",
  PENDING_AUTHS_AT_CAPACITY: "Pending auths at capacity (%d) — rejecting new authorize request",
} as const;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_CODE_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MAX_CLIENTS = 1000;
const DEFAULT_MAX_PENDING_AUTHS = 1000;
const DEFAULT_MAX_TOKENS = 5000;

/** How often to run the proactive TTL-based eviction sweep across all state maps. */
const EVICTION_INTERVAL_MS = 60_000;

/** Artificial AuthInfo lifetime — the token is re-verified via userinfo on each request. */
const AUTH_INFO_TTL_SECONDS = 3600;

// ============================================================================
// Public Types
// ============================================================================

/** Built-in provider type token. `oauth2` is the explicit-endpoint escape hatch. */
export type OAuthProviderType = "github" | "google" | "oidc" | "oauth2";

/**
 * Identifies which upstream provider a hook invocation pertains to.
 * - `type` — stable preset token; switch on this in {@link MapUserInfo}/{@link OnTokenExchanged}.
 * - `name` — unique routing key (also the selection-page `?provider=` value).
 * - `issuer` — present for OIDC-derived providers (`google` | `oidc`).
 */
export interface ProviderContext {
  readonly type: OAuthProviderType;
  readonly name: string;
  readonly issuer?: string | undefined;
}

/** Maps an upstream userinfo response to MCP {@link AuthInfo}. */
export type MapUserInfo = (ctx: ProviderContext, token: string, data: Record<string, unknown>) => Promise<AuthInfo>;

/**
 * Side-effect hook fired immediately after a successful upstream token exchange.
 * Receives the full raw token response (including `id_token` for OIDC providers).
 */
export type OnTokenExchanged = (
  ctx: ProviderContext,
  accessToken: string,
  tokenResponse: Record<string, unknown>,
) => Promise<void>;

/**
 * A provider-bound userinfo mapper — the {@link ProviderContext} is already closed over.
 * This is the shape stored on a {@link ResolvedProvider} and called by `verifyAccessToken`.
 */
export type BoundMapUserInfo = (token: string, data: Record<string, unknown>) => Promise<AuthInfo>;

/** Upstream OAuth endpoint URLs. */
export interface UpstreamEndpoints {
  /** Authorization endpoint (user is redirected here) */
  readonly authorizationUrl: string;

  /** Token endpoint (code → access_token exchange) */
  readonly tokenUrl: string;

  /** UserInfo endpoint for token verification. The response is passed to the provider's mapper. */
  readonly userinfoUrl?: string | undefined;

  /** Token revocation endpoint (RFC 7009) — optional */
  readonly revocationUrl?: string | undefined;
}

/**
 * Result of {@link createOAuthProvider}.
 *
 * Pass `provider` and `callbackHandler` to `AuthOptions`:
 * ```typescript
 * createServer({ auth: { provider, callbackHandler, issuerUrl: new URL(serverUrl) } });
 * ```
 */
export interface OAuthProviderResult {
  /** OAuthServerProvider for the framework's auth pipeline */
  readonly provider: OAuthServerProvider;

  /** Express handler for `GET /callback` — receives upstream redirects */
  readonly callbackHandler: RequestHandler;

  /** Release eviction timers. Call during server shutdown. */
  readonly dispose?: () => void;
}

/**
 * Fully resolved upstream provider definition with concrete credentials, endpoints,
 * and a provider-bound userinfo mapper. Produced by `./provider.ts` and consumed by
 * {@link createOAuthProviderCore}. Not exported from the package barrel.
 */
export interface ResolvedProvider {
  /** Provider identity passed to hooks (type, routing name, issuer). */
  readonly ctx: ProviderContext;
  /** Human-readable label for the provider-selection page. */
  readonly displayName: string;
  readonly endpoints: UpstreamEndpoints;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly tokenRequestContentType: "form" | "json";
  readonly upstreamAuthorizeParams?: Readonly<Record<string, string>> | undefined;
  readonly refreshTokenSupport: boolean;
  /** Provider-bound mapper (ProviderContext already closed over). */
  readonly mapUserInfo: BoundMapUserInfo;
}

/**
 * Timing, capacity, and hook options for {@link createOAuthProviderCore}.
 * Not exported from the package barrel.
 */
export interface OAuthProviderCoreOptions {
  readonly pendingAuthTtlMs?: number;
  readonly codeContextTtlMs?: number;
  readonly tokenTtlMs?: number;
  readonly maxClients?: number;
  readonly maxPendingAuths?: number;
  readonly maxTokens?: number;
  readonly onTokenExchanged?: OnTokenExchanged;
}

// ============================================================================
// Internal State Types
// ============================================================================

interface PendingAuth {
  /** Provider routing name (== ResolvedProvider.ctx.name) */
  readonly provider: string;
  readonly clientRedirectUri: string;
  readonly clientState: string;
  readonly codeChallenge: string;
  readonly createdAt: number;
}

interface CodeContext {
  /** Provider routing name (== ResolvedProvider.ctx.name) */
  readonly provider: string;
  readonly upstreamCode: string;
  readonly codeChallenge: string;
  readonly createdAt: number;
}

interface TokenEntry {
  /** Provider routing name (== ResolvedProvider.ctx.name) */
  readonly provider: string;
  readonly userinfoUrl: string;
  readonly createdAt: number;
}

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * AuthInfo expiry timestamp: `now + 1h` (epoch seconds).
 * Tokens are re-verified via the userinfo endpoint on each request, so this is an
 * artificial lifetime that satisfies the SDK's `requireBearerAuth` middleware.
 * Exported for consumers writing custom userinfo mappers.
 */
export function authInfoExpiry(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + AUTH_INFO_TTL_SECONDS;
}

/**
 * Builds an SDK {@link OAuthTokens} object from a parsed upstream token response,
 * with consistent `expires_in` validation. Shared by the authorization-code and
 * refresh-token exchange paths.
 */
function buildOAuthTokens(tokenData: Record<string, unknown>): OAuthTokens {
  const rawExpiresIn = tokenData.expires_in;
  const expiresIn = rawExpiresIn !== undefined ? Number(rawExpiresIn) : undefined;
  if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 1)) {
    throw new ServerError(`Invalid expires_in from upstream token response: ${String(rawExpiresIn)}`);
  }
  return {
    access_token: tokenData.access_token as string,
    token_type: typeof tokenData.token_type === "string" ? tokenData.token_type : "bearer",
    expires_in: expiresIn ?? AUTH_INFO_TTL_SECONDS,
    ...(typeof tokenData.refresh_token === "string" && { refresh_token: tokenData.refresh_token }),
    ...(typeof tokenData.scope === "string" && { scope: tokenData.scope }),
  };
}

// ============================================================================
// Core Implementation
// ============================================================================

/**
 * Unified core implementation of the server-side callback OAuth pattern.
 *
 * Supports 1..N upstream providers with a single shared callback URL.
 * When a single provider is configured the user is redirected directly.
 * When multiple providers are configured a provider-selection page is rendered.
 *
 * Not exported from the package barrel — invoke via {@link createOAuthProvider}
 * in `./provider.ts`.
 *
 * @param serverCallbackUrl - Full callback URL, e.g. `http://localhost:8000/callback`
 * @param providers - One or more resolved upstream provider definitions
 * @param options - Timing, capacity, and hook options
 */
export function createOAuthProviderCore(
  serverCallbackUrl: string,
  providers: readonly ResolvedProvider[],
  options: OAuthProviderCoreOptions = {},
): OAuthProviderResult {
  if (providers.length === 0) {
    throw new Error("createOAuthProviderCore: at least one provider is required");
  }

  const {
    pendingAuthTtlMs = DEFAULT_PENDING_AUTH_TTL_MS,
    codeContextTtlMs = DEFAULT_CODE_CONTEXT_TTL_MS,
    tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
    maxClients = DEFAULT_MAX_CLIENTS,
    maxPendingAuths = DEFAULT_MAX_PENDING_AUTHS,
    maxTokens = DEFAULT_MAX_TOKENS,
    onTokenExchanged,
  } = options;

  const logger = baseLogger.child({ component: "oauth-core" });
  const firstProvider = providers[0]!;

  // Build fast name → provider lookup
  const providerMap = new Map<string, ResolvedProvider>();
  for (const p of providers) providerMap.set(p.ctx.name, p);

  // ── State Maps ──────────────────────────────────────────────────────────────

  const pendingAuths = new BoundedMap<string, PendingAuth>(maxPendingAuths);
  // codeContexts is bounded by pendingAuths capacity (one code per auth flow)
  const codeContexts = new BoundedMap<string, CodeContext>(maxPendingAuths);
  const tokenRegistry = new BoundedMap<string, TokenEntry>(maxTokens);
  const clients = new BoundedMap<string, OAuthClientInformationFull>(maxClients, (key) =>
    logger.warn(LogMessages.CLIENT_EVICTED, maxClients, key),
  );

  // ── Periodic Eviction ─────────────────────────────────────────────────────
  // Proactively removes expired entries between capacity-triggered evictions.
  // Prevents abandoned auth flows (DoS via /authorize flooding) from consuming
  // memory until the capacity limit is reached.
  const evictionTimer = setInterval(() => {
    pendingAuths.evictExpired(pendingAuthTtlMs, (e) => e.createdAt);
    codeContexts.evictExpired(codeContextTtlMs, (e) => e.createdAt);
    tokenRegistry.evictExpired(tokenTtlMs, (e) => e.createdAt);
  }, EVICTION_INTERVAL_MS);
  evictionTimer.unref();

  // ── OAuthServerProvider ──────────────────────────────────────────────────────

  const provider: OAuthServerProvider = {
    get skipLocalPkceValidation(): boolean {
      return false;
    },

    // ── Client Store ────────────────────────────────────────────────────────────

    clientsStore: {
      getClient: async (id: string) => {
        const client = clients.get(id);
        logger.debug(LogMessages.GET_CLIENT, id, client ? "found" : "not found");
        return client;
      },

      registerClient: async (clientInfo: OAuthClientInformationFull): Promise<OAuthClientInformationFull> => {
        clients.set(clientInfo.client_id, clientInfo);
        logger.info(LogMessages.REGISTERED_CLIENT, clientInfo.client_id);
        return clientInfo;
      },
    },

    // ── Authorize ───────────────────────────────────────────────────────────────

    async authorize(
      client: OAuthClientInformationFull,
      params: { redirectUri: string; state: string; codeChallenge: string; scopes?: string[] },
      res: Response,
    ): Promise<void> {
      // @sdk-contract — res.req is set by Express before the SDK calls authorize()
      const req = (res as unknown as { req?: Request }).req;
      if (!req) throw new Error("authorize() called without an attached Express request (res.req undefined)");
      const selectedProvider = typeof req.query["provider"] === "string" ? req.query["provider"] : undefined;

      // Multiple providers and none selected → render selection page
      if (!selectedProvider && providers.length > 1) {
        res.type("html").send(
          renderSelectionPage(
            req.originalUrl,
            providers.map((p) => ({ name: p.ctx.name, displayName: p.displayName })),
          ),
        );
        return;
      }

      const providerName = selectedProvider ?? firstProvider.ctx.name;
      const prov = providerMap.get(providerName);

      if (!prov) {
        logger.warn("Authorize: unknown provider=%s (known: %s)", providerName, [...providerMap.keys()].join(", "));
        res.status(400).json({ error: "invalid_request", error_description: "Unknown provider" });
        return;
      }

      if (pendingAuths.size >= maxPendingAuths) {
        logger.warn(LogMessages.PENDING_AUTHS_AT_CAPACITY, maxPendingAuths);
        res
          .status(503)
          .json({ error: "too_many_requests", error_description: "Authorization service temporarily at capacity" });
        return;
      }

      const upstreamState = crypto.randomUUID();
      pendingAuths.set(upstreamState, {
        provider: providerName,
        clientRedirectUri: params.redirectUri,
        clientState: params.state,
        codeChallenge: params.codeChallenge,
        createdAt: Date.now(),
      });
      logger.info(LogMessages.AUTHORIZE, client.client_id, providerName, upstreamState);

      const authUrl = new URL(prov.endpoints.authorizationUrl);
      authUrl.searchParams.set("client_id", prov.clientId);
      authUrl.searchParams.set("redirect_uri", serverCallbackUrl);
      authUrl.searchParams.set("state", upstreamState);
      authUrl.searchParams.set("scope", prov.scopes.join(" "));

      if (prov.upstreamAuthorizeParams) {
        for (const [key, value] of Object.entries(prov.upstreamAuthorizeParams)) {
          authUrl.searchParams.set(key, value);
        }
      }

      res.redirect(authUrl.toString());
    },

    // ── PKCE Challenge ──────────────────────────────────────────────────────────

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<string> {
      const ctx = codeContexts.get(authorizationCode);
      if (!ctx) throw new InvalidGrantError("Authorization code invalid or expired");
      // TTL check mirrors exchangeAuthorizationCode — but does NOT delete here.
      // The SDK calls challengeForAuthorizationCode first (PKCE), then exchangeAuthorizationCode
      // (deletion). Rejecting early gives a consistent error before PKCE verification runs.
      if (Date.now() - ctx.createdAt > codeContextTtlMs) {
        throw new InvalidGrantError("Authorization code expired");
      }
      return ctx.codeChallenge;
    },

    // ── Token Exchange ──────────────────────────────────────────────────────────

    async exchangeAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
    ): Promise<OAuthTokens> {
      const ctx = codeContexts.get(authorizationCode);
      if (!ctx) throw new InvalidGrantError("Authorization code invalid or expired");
      if (Date.now() - ctx.createdAt > codeContextTtlMs) {
        codeContexts.delete(authorizationCode);
        throw new InvalidGrantError("Authorization code expired");
      }
      codeContexts.delete(authorizationCode);

      const prov = providerMap.get(ctx.provider);
      if (!prov) throw new InvalidGrantError(`Unknown provider in code context: ${ctx.provider}`);

      logger.debug(LogMessages.TOKEN_EXCHANGE, ctx.provider, ctx.upstreamCode.slice(0, 8));

      const response = await fetchToken(
        prov.endpoints.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: prov.clientId,
          client_secret: prov.clientSecret,
          code: ctx.upstreamCode,
          redirect_uri: serverCallbackUrl,
        },
        prov.tokenRequestContentType,
      );

      const tokenData = await parseTokenResponse(response, `token exchange (${ctx.provider})`);
      const accessToken = tokenData.access_token as string;

      if (onTokenExchanged) {
        await onTokenExchanged(prov.ctx, accessToken, tokenData);
      }

      // Register token → provider/userinfoUrl for verifyAccessToken routing
      if (prov.endpoints.userinfoUrl) {
        tokenRegistry.set(accessToken, {
          provider: ctx.provider,
          userinfoUrl: prov.endpoints.userinfoUrl,
          createdAt: Date.now(),
        });
      }

      return buildOAuthTokens(tokenData);
    },

    // ── Token Verification ──────────────────────────────────────────────────────

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const entry = tokenRegistry.get(token);

      let userinfoUrl: string;
      let mapUserInfo: BoundMapUserInfo;

      if (entry) {
        const prov = providerMap.get(entry.provider);
        if (!prov) throw new InvalidTokenError("Token references unknown provider");
        userinfoUrl = entry.userinfoUrl;
        mapUserInfo = prov.mapUserInfo;
      } else if (providers.length === 1 && firstProvider.endpoints.userinfoUrl) {
        // Single-provider fallback: verify without registry entry.
        // Covers tokens issued before the registry existed, or tokens from refresh flows
        // where the new access token was not re-registered.
        userinfoUrl = firstProvider.endpoints.userinfoUrl;
        mapUserInfo = firstProvider.mapUserInfo;
      } else {
        throw new InvalidTokenError("Token unknown or expired");
      }

      let response: globalThis.Response;
      try {
        response = await fetch(userinfoUrl, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        throw new ServerError(`Token verification network error: ${err instanceof Error ? err.message : "unknown"}`);
      }

      if (!response.ok) {
        if (response.status === 401) tokenRegistry.delete(token); // evict stale token proactively
        throw new InvalidTokenError(`Token verification failed (HTTP ${response.status})`);
      }

      assertJsonContentType(response, "userinfo endpoint");
      const data = (await response.json()) as Record<string, unknown>;
      return mapUserInfo(token, data);
    },

    // ── Refresh Token ───────────────────────────────────────────────────────────

    async exchangeRefreshToken(
      _client: OAuthClientInformationFull,
      refreshToken: string,
      _scopes?: string[],
    ): Promise<OAuthTokens> {
      // Refresh tokens are only supported for single-provider configurations that
      // explicitly opt in. Multi-provider setups cannot route refresh tokens to the
      // correct upstream without tracking which provider issued the original token.
      if (providers.length !== 1 || !firstProvider.refreshTokenSupport) {
        throw new UnsupportedGrantTypeError("Refresh tokens are not supported by this provider");
      }
      const prov = firstProvider;
      const response = await fetchToken(
        prov.endpoints.tokenUrl,
        {
          grant_type: "refresh_token",
          client_id: prov.clientId,
          client_secret: prov.clientSecret,
          refresh_token: refreshToken,
        },
        prov.tokenRequestContentType,
      );

      const tokenData = await parseTokenResponse(response, "refresh token exchange");
      return buildOAuthTokens(tokenData);
    },

    // ── Revoke Token ────────────────────────────────────────────────────────────

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
      const entry = tokenRegistry.get(request.token);
      tokenRegistry.delete(request.token);

      // Route revocation to the correct upstream endpoint
      const prov = entry ? providerMap.get(entry.provider) : providers.length === 1 ? firstProvider : undefined;

      if (!prov?.endpoints.revocationUrl) return;

      const params = new URLSearchParams({
        token: request.token,
        client_id: prov.clientId,
        client_secret: prov.clientSecret,
      });
      if (request.token_type_hint) params.set("token_type_hint", request.token_type_hint);

      try {
        const response = await fetch(prov.endpoints.revocationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) logger.warn("Token revocation failed (HTTP %d)", response.status);
      } catch {
        logger.warn("Token revocation request failed");
      }
    },
  };

  // ── Callback Handler ─────────────────────────────────────────────────────────

  const callbackHandler: RequestHandler = (req: Request, res: Response) => {
    const code = typeof req.query["code"] === "string" ? req.query["code"] : undefined;
    const state = typeof req.query["state"] === "string" ? req.query["state"] : undefined;
    const error = typeof req.query["error"] === "string" ? req.query["error"] : undefined;

    if (error) {
      const desc = typeof req.query["error_description"] === "string" ? req.query["error_description"] : undefined;
      // Log upstream details for debugging; send generic message to prevent information disclosure (CWE-209)
      logger.warn("OAuth callback error from upstream: %s — %s", error, desc ?? "(no description)");
      res.status(400).send("Authorization failed");
      return;
    }

    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }

    const pending = pendingAuths.get(state);
    if (!pending) {
      logger.warn(LogMessages.CALLBACK_INVALID_STATE, state);
      res.status(400).send("Invalid or expired state parameter");
      return;
    }

    if (Date.now() - pending.createdAt > pendingAuthTtlMs) {
      pendingAuths.delete(state);
      logger.warn(LogMessages.CALLBACK_EXPIRED, state);
      res.status(400).send("Authorization request expired");
      return;
    }

    pendingAuths.delete(state);

    // Defense-in-depth: re-validate the stored redirect URI at callback time.
    // The URI was validated at authorize time, but re-checking guards against
    // stale entries or store mutations between authorize and callback.
    const redirectUrl = parseClientRedirectUri(pending.clientRedirectUri);
    if (!redirectUrl) {
      logger.warn("Callback: rejected unsafe or invalid clientRedirectUri: %s", pending.clientRedirectUri);
      res.status(400).send("Invalid redirect URI");
      return;
    }

    // Generate a new UUID code that carries provider routing metadata.
    // The upstream code is stored internally; the client only ever sees our UUID.
    const ourCode = crypto.randomUUID();
    codeContexts.set(ourCode, {
      provider: pending.provider,
      upstreamCode: code,
      codeChallenge: pending.codeChallenge,
      createdAt: Date.now(),
    });
    logger.info(LogMessages.CALLBACK_SUCCESS, pending.provider);

    redirectUrl.searchParams.set("code", ourCode);
    redirectUrl.searchParams.set("state", pending.clientState);
    res.redirect(redirectUrl.toString());
  };

  return {
    provider,
    callbackHandler,
    dispose: () => clearInterval(evictionTimer),
  };
}
