/**
 * Upstream OAuth Provider Factory
 *
 * Creates a generic {@link OAuthServerProvider} that proxies OAuth flows
 * to any upstream authorization server using the **server-side callback pattern**.
 *
 * This pattern is needed because MCP clients (Inspector, VS Code, Claude Desktop)
 * each have their own callback URL, but upstream providers (GitHub, Google, etc.)
 * validate `redirect_uri` against the registered callback. By routing all callbacks
 * through the MCP server, we solve this mismatch transparently.
 *
 * Flow:
 *   Client → MCP Server /authorize → Upstream /authorize
 *     (redirect_uri = MCP Server /callback)
 *   Upstream → MCP Server /callback?code=X&state=UP
 *   MCP Server → Client callback?code=X&state=DOWN
 *   Client → MCP Server /token (code=X)
 *   MCP Server → Upstream token endpoint → returns token
 *
 * @example
 * ```typescript
 * import { createUpstreamOAuthProvider } from 'mcp-server-framework';
 *
 * const { provider, callbackHandler } = createUpstreamOAuthProvider({
 *   endpoints: {
 *     authorizationUrl: 'https://github.com/login/oauth/authorize',
 *     tokenUrl: 'https://github.com/login/oauth/access_token',
 *     userinfoUrl: 'https://api.github.com/user',
 *   },
 *   clientId: process.env.GITHUB_CLIENT_ID!,
 *   clientSecret: process.env.GITHUB_CLIENT_SECRET!,
 *   serverUrl: 'http://localhost:8000',
 *   upstreamScopes: ['read:user'],
 *   tokenRequestContentType: 'json',
 *   mapUserInfo: async (token, data) => ({
 *     token,
 *     clientId: data.login as string,
 *     scopes: ['read', 'write'],
 *     expiresAt: Math.floor(Date.now() / 1000) + 3600,
 *   }),
 * });
 *
 * createServer({
 *   auth: { provider, callbackHandler, issuerUrl: new URL('http://localhost:8000') },
 * });
 * ```
 *
 * @module server/auth/upstream-provider
 */

import crypto from "node:crypto";
import type { Request, Response, RequestHandler } from "express";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { logger as baseLogger } from "../../logger/index.js";
import { stripTrailingSlashes } from "../../utils/string-helpers.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "upstream-oauth";

const LogMessages = {
  GET_CLIENT: "getClient: %s → %s",
  REGISTERED_CLIENT: "Registered client: %s",
  AUTHORIZE: "Authorize: client=%s redirectUri=%s upstreamState=%s",
  TOKEN_EXCHANGE: "Token exchange: code=%s…",
  TOKEN_EXCHANGE_ERROR: "Upstream token exchange error: %s",
  CALLBACK_INVALID_STATE: "Callback: invalid or expired state=%s",
  CALLBACK_EXPIRED: "Callback: expired pending auth state=%s",
  CALLBACK_SUCCESS: "Callback: state mapped, redirecting to client",
  PENDING_AUTHS_AT_CAPACITY: "Pending auths at capacity (%d) — rejecting new authorize request",
} as const;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_CODE_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_FETCH_TIMEOUT_MS = 10_000; // 10s — prevent unbounded upstream calls
const DEFAULT_EVICTION_INTERVAL_MS = 60_000; // 1 min — periodic cleanup of expired state
const DEFAULT_MAX_CLIENTS = 1000; // Max registered clients — prevents unbounded memory growth
const DEFAULT_MAX_PENDING_AUTHS = 1000; // Max pending auth flows — prevents memory exhaustion via /authorize flooding

// ============================================================================
// Types
// ============================================================================

/**
 * Upstream OAuth endpoint URLs.
 */
export interface UpstreamEndpoints {
  /** Authorization endpoint (user is redirected here) */
  readonly authorizationUrl: string;

  /** Token endpoint (code → access_token exchange) */
  readonly tokenUrl: string;

  /**
   * UserInfo endpoint for token verification.
   * The response is passed to {@link UpstreamOAuthOptions.mapUserInfo}.
   * Required unless a custom `verifyAccessToken` is provided.
   */
  readonly userinfoUrl?: string | undefined;

  /** Token revocation endpoint (optional) */
  readonly revocationUrl?: string | undefined;
}

/**
 * Options for {@link createUpstreamOAuthProvider}.
 */
export interface UpstreamOAuthOptions {
  /** Upstream OAuth endpoint URLs */
  readonly endpoints: UpstreamEndpoints;

  /** Client ID registered with the upstream OAuth provider */
  readonly clientId: string;

  /** Client secret registered with the upstream OAuth provider */
  readonly clientSecret: string;

  /** MCP server base URL (e.g. `http://localhost:8000`). Used as `redirect_uri` target. */
  readonly serverUrl: string;

  /** Scopes to request from the upstream provider (e.g. `['read:user']`, `['openid', 'profile']`) */
  readonly upstreamScopes: readonly string[];

  /**
   * Map the upstream userinfo response to MCP {@link AuthInfo}.
   *
   * Called by `verifyAccessToken()` after fetching the userinfo endpoint.
   * The `data` parameter contains the parsed JSON response from the userinfo URL.
   *
   * @param token - The access token being verified
   * @param data - Parsed JSON response from the userinfo endpoint
   * @returns Auth info for the MCP session
   */
  readonly mapUserInfo: (token: string, data: Record<string, unknown>) => Promise<AuthInfo>;

  /**
   * Content type for the token exchange request.
   * - `'form'` — `application/x-www-form-urlencoded` (OAuth 2.1 standard, default)
   * - `'json'` — `application/json` (used by GitHub)
   *
   * @default 'form'
   */
  readonly tokenRequestContentType?: "form" | "json";

  /**
   * Extra query parameters appended to the upstream authorization URL.
   * Useful for non-standard providers that need additional parameters
   * like `response_type`, `access_type`, etc.
   *
   * Standard parameters (`client_id`, `redirect_uri`, `state`, `scope`)
   * are set automatically and should NOT be included here.
   */
  readonly upstreamAuthorizeParams?: Readonly<Record<string, string>>;

  /**
   * Whether the upstream provider supports refresh tokens.
   * When `true`, `exchangeRefreshToken()` proxies to the token endpoint.
   *
   * @default false
   */
  readonly refreshTokenSupport?: boolean;

  /**
   * TTL for pending authorization state (upstream state → client info mapping).
   * @default 600000 (10 minutes)
   */
  readonly pendingAuthTtlMs?: number;

  /**
   * TTL for code context (authorization code → redirect_uri mapping).
   * @default 300000 (5 minutes)
   */
  readonly codeContextTtlMs?: number;
}

/**
 * Result of {@link createUpstreamOAuthProvider}.
 *
 * Pass `provider` and `callbackHandler` to {@link AuthOptions}:
 * ```typescript
 * createServer({
 *   auth: { provider, callbackHandler, issuerUrl: new URL(serverUrl) },
 * });
 * ```
 */
export interface UpstreamOAuthProviderResult {
  /** OAuthServerProvider for the framework's auth pipeline */
  readonly provider: OAuthServerProvider;

  /** Express handler for `GET /callback` — receives upstream redirects */
  readonly callbackHandler: RequestHandler;

  /** Dispose cleanup resources (eviction timers). Called during server shutdown. */
  readonly dispose?: () => void;
}

// ============================================================================
// Internal State Types
// ============================================================================

/** Maps upstream state → MCP client info for callback routing */
interface PendingAuth {
  readonly clientRedirectUri: string;
  readonly clientState: string;
  readonly codeChallenge: string;
  readonly createdAt: number;
}

/** Maps authorization code → the redirect_uri used with the upstream provider */
interface CodeContext {
  readonly serverCallbackUrl: string;
  readonly createdAt: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an {@link OAuthServerProvider} that proxies OAuth flows to an
 * upstream authorization server using server-side callbacks.
 *
 * This is the generic extraction of the server-side callback pattern —
 * all provider-specific logic is encapsulated in the options (endpoints,
 * scopes, `mapUserInfo`). The boilerplate (client store, state mapping,
 * callback handler, token exchange, TTL management) is handled here.
 *
 * @param options - Upstream OAuth configuration
 * @returns Provider and callback handler, ready for {@link AuthOptions}
 */
export function createUpstreamOAuthProvider(options: UpstreamOAuthOptions): UpstreamOAuthProviderResult {
  const {
    endpoints,
    clientId,
    clientSecret,
    serverUrl,
    upstreamScopes,
    mapUserInfo,
    tokenRequestContentType = "form",
    upstreamAuthorizeParams,
    refreshTokenSupport = false,
    pendingAuthTtlMs = DEFAULT_PENDING_AUTH_TTL_MS,
    codeContextTtlMs = DEFAULT_CODE_CONTEXT_TTL_MS,
  } = options;

  const logger = baseLogger.child({ component: LOG_COMPONENT });
  const serverCallbackUrl = `${stripTrailingSlashes(serverUrl)}/callback`;

  // ── State Maps ──────────────────────────────────────────────────────────

  const pendingAuths = new Map<string, PendingAuth>();
  const codeContexts = new Map<string, CodeContext>();
  const clients = new Map<string, OAuthClientInformationFull>();

  // ── Periodic Eviction ─────────────────────────────────────────────────
  // Proactively evict expired entries from pendingAuths and codeContexts.
  // Without this, abandoned OAuth flows (attacker starts /authorize but never
  // completes callback) accumulate indefinitely in memory.
  const evictionTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingAuths) {
      if (now - entry.createdAt > pendingAuthTtlMs) {
        pendingAuths.delete(key);
      }
    }
    for (const [key, entry] of codeContexts) {
      if (now - entry.createdAt > codeContextTtlMs) {
        codeContexts.delete(key);
      }
    }
  }, DEFAULT_EVICTION_INTERVAL_MS);
  evictionTimer.unref(); // Don't keep the process alive for cleanup

  // ── OAuthServerProvider ─────────────────────────────────────────────────

  const provider: OAuthServerProvider = {
    // Server-side callback pattern: PKCE is validated by the upstream provider,
    // not by the MCP server. Skip local PKCE validation in the SDK.
    get skipLocalPkceValidation(): boolean {
      return true;
    },

    // ── Client Store (in-memory, dynamic registration) ──────────────────

    clientsStore: {
      getClient: async (id: string) => {
        const client = clients.get(id);
        logger.debug(LogMessages.GET_CLIENT, id, client ? "found" : "not found");
        return client;
      },

      registerClient: async (clientInfo: OAuthClientInformationFull): Promise<OAuthClientInformationFull> => {
        // Guard against unbounded client accumulation (e.g., automated registration abuse).
        // Evict the oldest entry (FIFO via Map insertion order) when at capacity.
        if (!clients.has(clientInfo.client_id) && clients.size >= DEFAULT_MAX_CLIENTS) {
          const oldestKey = clients.keys().next().value;
          if (oldestKey !== undefined) {
            clients.delete(oldestKey);
            logger.warn("Client store at capacity (%d) — evicted oldest client: %s", DEFAULT_MAX_CLIENTS, oldestKey);
          }
        }

        clients.set(clientInfo.client_id, clientInfo);
        logger.info(LogMessages.REGISTERED_CLIENT, clientInfo.client_id);
        return clientInfo;
      },
    },

    // ── Authorize: Redirect to upstream with server callback URL ────────

    async authorize(
      client: OAuthClientInformationFull,
      params: {
        redirectUri: string;
        state: string;
        codeChallenge: string;
        scopes?: string[];
      },
      res: Response,
    ): Promise<void> {
      // Guard against unbounded pendingAuths accumulation (DoS vector via /authorize flooding)
      if (pendingAuths.size >= DEFAULT_MAX_PENDING_AUTHS) {
        logger.warn(LogMessages.PENDING_AUTHS_AT_CAPACITY, DEFAULT_MAX_PENDING_AUTHS);
        res
          .status(503)
          .json({ error: "too_many_requests", error_description: "Authorization service temporarily at capacity" });
        return;
      }

      const upstreamState = crypto.randomUUID();
      pendingAuths.set(upstreamState, {
        clientRedirectUri: params.redirectUri,
        clientState: params.state,
        codeChallenge: params.codeChallenge,
        createdAt: Date.now(),
      });
      logger.info(LogMessages.AUTHORIZE, client.client_id, params.redirectUri, upstreamState);

      const url = new URL(endpoints.authorizationUrl);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", serverCallbackUrl);
      url.searchParams.set("state", upstreamState);
      url.searchParams.set("scope", upstreamScopes.join(" "));

      // Apply extra authorize params (e.g. response_type for OIDC)
      if (upstreamAuthorizeParams) {
        for (const [key, value] of Object.entries(upstreamAuthorizeParams)) {
          url.searchParams.set(key, value);
        }
      }

      res.redirect(url.toString());
    },

    // ── PKCE Challenge (not called when skipLocalPkceValidation=true) ────

    async challengeForAuthorizationCode(
      _client: OAuthClientInformationFull,
      _authorizationCode: string,
    ): Promise<string> {
      throw new Error("PKCE validation is handled by the upstream provider");
    },

    // ── Token Exchange ──────────────────────────────────────────────────

    async exchangeAuthorizationCode(
      _client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      _redirectUri?: string,
    ): Promise<OAuthTokens> {
      logger.debug(LogMessages.TOKEN_EXCHANGE, authorizationCode.slice(0, 8));

      // Resolve and validate code context
      const ctx = codeContexts.get(authorizationCode);
      if (ctx && Date.now() - ctx.createdAt > codeContextTtlMs) {
        codeContexts.delete(authorizationCode);
        throw new Error("Authorization code expired");
      }
      codeContexts.delete(authorizationCode);

      const redirectUri = ctx?.serverCallbackUrl ?? serverCallbackUrl;
      const response = await fetchToken(
        endpoints.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code: authorizationCode,
          redirect_uri: redirectUri,
        },
        tokenRequestContentType,
      );

      assertJsonContentType(response, "token exchange");
      const data = (await response.json()) as Record<string, string>;
      if (data.error) {
        logger.error(LogMessages.TOKEN_EXCHANGE_ERROR, data.error_description ?? data.error);
        throw new Error(data.error_description ?? data.error);
      }

      if (!data.access_token) {
        throw new Error("Upstream token response missing access_token");
      }

      const expiresIn = data.expires_in ? Number(data.expires_in) : undefined;
      if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 1)) {
        throw new Error(`Invalid expires_in from upstream token response: ${data.expires_in}`);
      }

      return {
        access_token: data.access_token,
        token_type: data.token_type ?? "bearer",
        // Artificial 1h expiry when upstream doesn't provide one
        expires_in: expiresIn ?? 3600,
        ...(data.refresh_token && { refresh_token: data.refresh_token }),
        ...(data.scope && { scope: data.scope }),
      };
    },

    // ── Token Verification via UserInfo endpoint ────────────────────────

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!endpoints.userinfoUrl) {
        throw new Error("No userinfoUrl configured — cannot verify access token");
      }

      let response: globalThis.Response;
      try {
        response = await fetch(endpoints.userinfoUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`Token verification failed: ${err instanceof Error ? err.message : "network error"}`, {
          cause: err,
        });
      }

      if (!response.ok) {
        throw new Error(`Token verification failed (HTTP ${response.status})`);
      }

      assertJsonContentType(response, "userinfo");
      const data = (await response.json()) as Record<string, unknown>;
      return mapUserInfo(token, data);
    },

    // ── Refresh Token ───────────────────────────────────────────────────

    async exchangeRefreshToken(
      _client: OAuthClientInformationFull,
      refreshToken: string,
      _scopes?: string[],
    ): Promise<OAuthTokens> {
      if (!refreshTokenSupport) {
        throw new Error("Refresh tokens are not supported by this provider");
      }

      const response = await fetchToken(
        endpoints.tokenUrl,
        {
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        },
        tokenRequestContentType,
      );

      assertJsonContentType(response, "refresh token exchange");
      const data = (await response.json()) as Record<string, string>;
      if (data.error) {
        throw new Error(data.error_description ?? data.error);
      }

      if (!data.access_token) {
        throw new Error("Upstream refresh token response missing access_token");
      }

      return {
        access_token: data.access_token,
        token_type: data.token_type ?? "bearer",
        ...(data.expires_in && { expires_in: Number(data.expires_in) }),
        ...(data.refresh_token && { refresh_token: data.refresh_token }),
      };
    },

    // ── Revoke Token ────────────────────────────────────────────────────

    async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
      if (!endpoints.revocationUrl) return;

      const params = new URLSearchParams({
        token: request.token,
        client_id: clientId,
        client_secret: clientSecret,
      });
      if (request.token_type_hint) {
        params.set("token_type_hint", request.token_type_hint);
      }

      try {
        const response = await fetch(endpoints.revocationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          logger.warn("Token revocation failed (HTTP %d)", response.status);
        }
      } catch {
        logger.warn("Token revocation request failed");
      }
    },
  };

  // ── Callback Handler ────────────────────────────────────────────────────

  const callbackHandler: RequestHandler = (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      const desc = req.query.error_description as string | undefined;
      // Log upstream error details for debugging, but send generic message to client
      // to prevent information disclosure (CWE-209)
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
    // stale entries or client store mutations between authorize and callback.
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(pending.clientRedirectUri);
      if (
        redirectUrl.protocol !== "https:" &&
        !(
          redirectUrl.protocol === "http:" &&
          (redirectUrl.hostname === "localhost" ||
            redirectUrl.hostname === "127.0.0.1" ||
            redirectUrl.hostname === "::1")
        )
      ) {
        logger.warn("Callback: rejected unsafe clientRedirectUri scheme: %s", redirectUrl.protocol);
        res.status(400).send("Invalid redirect URI");
        return;
      }
    } catch {
      logger.warn("Callback: invalid clientRedirectUri URL");
      res.status(400).send("Invalid redirect URI");
      return;
    }

    codeContexts.set(code, { serverCallbackUrl, createdAt: Date.now() });
    logger.info(LogMessages.CALLBACK_SUCCESS);

    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", pending.clientState);
    res.redirect(redirectUrl.toString());
  };

  return {
    provider,
    callbackHandler,
    dispose: () => {
      clearInterval(evictionTimer);
    },
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Asserts that a fetch Response carries a JSON Content-Type before parsing.
 * Throws a descriptive error when upstream returns HTML error pages or other
 * non-JSON bodies (e.g. from WAFs, proxies, or misconfigured endpoints).
 */
function assertJsonContentType(response: globalThis.Response, context: string): void {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new Error(`Expected JSON from ${context}, got Content-Type: ${ct} (HTTP ${response.status})`);
  }
}

/**
 * Sends a token request to the upstream provider.
 * Supports both `application/x-www-form-urlencoded` (standard) and
 * `application/json` (GitHub) content types.
 */
async function fetchToken(
  tokenUrl: string,
  params: Record<string, string>,
  contentType: "form" | "json",
): Promise<globalThis.Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string;

  if (contentType === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }

  try {
    return await fetch(tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Token request to ${tokenUrl} failed: ${err instanceof Error ? err.message : "network error"}`, {
      cause: err,
    });
  }
}
