/**
 * OIDC Provider Factory
 *
 * Creates an {@link OAuthServerProvider} for any OpenID Connect-compliant
 * authorization server using **automatic endpoint discovery**.
 *
 * Given just an issuer URL, the factory fetches the OIDC discovery document
 * (`/.well-known/openid-configuration`) and configures a full upstream OAuth
 * provider with server-side callbacks. This eliminates per-provider boilerplate
 * for standard OIDC providers (Keycloak, Auth0, Okta, Azure AD, PocketID, etc.).
 *
 * @example
 * ```typescript
 * import { createOidcProvider, createServer } from 'mcp-server-framework';
 *
 * const { provider, callbackHandler } = await createOidcProvider({
 *   issuer: 'https://auth.example.com',
 *   clientId: process.env.OIDC_CLIENT_ID!,
 *   clientSecret: process.env.OIDC_CLIENT_SECRET!,
 *   serverUrl: 'http://localhost:8000',
 * });
 *
 * const { start } = createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   auth: {
 *     provider,
 *     callbackHandler,
 *     issuerUrl: new URL('http://localhost:8000'),
 *   },
 * });
 * await start();
 * ```
 *
 * @module server/auth/oidc-provider
 */

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getOidcDiscovery } from "./oidc-discovery.js";
import { createUpstreamOAuthProvider } from "./upstream-provider.js";
import type { UpstreamOAuthProviderResult } from "./upstream-provider.js";
import { logger as baseLogger } from "../../logger/index.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "oidc-provider";

const LogMessages = {
  CREATING: "Creating OIDC provider for issuer %s",
  CREATED: "OIDC provider ready (authorization=%s, token=%s, userinfo=%s)",
  NO_USERINFO: "OIDC discovery for %s has no userinfo_endpoint — token verification may fail",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Constants
// ============================================================================

/** Default OIDC scopes to request from the upstream provider */
const DEFAULT_UPSTREAM_SCOPES = ["openid", "profile", "email"] as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Standard OIDC UserInfo claims.
 *
 * @see https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims
 */
interface OidcUserInfoClaims {
  readonly sub: string;
  readonly name?: string;
  readonly preferred_username?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly picture?: string;
}

/**
 * Options for {@link createOidcProvider}.
 */
export interface OidcProviderOptions {
  /**
   * OIDC issuer URL (e.g. `https://auth.example.com`).
   * The discovery document is fetched from `{issuer}/.well-known/openid-configuration`.
   */
  readonly issuer: string;

  /** Client ID registered with the OIDC provider */
  readonly clientId: string;

  /** Client secret registered with the OIDC provider */
  readonly clientSecret: string;

  /** MCP server base URL (e.g. `http://localhost:8000`). Used as redirect_uri target. */
  readonly serverUrl: string;

  /**
   * Scopes to request from the upstream OIDC provider.
   * @default ['openid', 'profile', 'email']
   */
  readonly upstreamScopes?: readonly string[];

  /**
   * MCP scopes granted to authenticated users.
   * If not provided, the default `mapUserInfo` grants no scopes (empty array).
   * When providing a custom `mapUserInfo`, this option is ignored.
   */
  readonly grantedScopes?: readonly string[];

  /**
   * Custom mapping from OIDC UserInfo response to MCP {@link AuthInfo}.
   *
   * When not provided, the default mapping uses standard OIDC claims:
   * - `sub` → `clientId`
   * - `grantedScopes` → `scopes`
   * - 1h artificial `expiresAt` (token is re-verified on each request)
   * - `name`, `email`, `preferred_username` → `extra`
   */
  readonly mapUserInfo?: (token: string, data: Record<string, unknown>) => Promise<AuthInfo>;

  /**
   * TTL for the cached OIDC discovery document in milliseconds.
   * The discovery document is re-fetched when the TTL expires.
   * @default 3600000 (1 hour)
   */
  readonly discoveryTtlMs?: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an {@link OAuthServerProvider} for an OIDC-compliant authorization server.
 *
 * This is an **async factory** — it fetches the OIDC discovery document at creation
 * time to resolve endpoint URLs. The discovery document is cached with a configurable
 * TTL and refreshed transparently on subsequent token verifications.
 *
 * Internally delegates to {@link createUpstreamOAuthProvider} after resolving endpoints.
 *
 * @param options - OIDC provider configuration
 * @returns Provider and callback handler, ready for {@link AuthOptions}
 */
export async function createOidcProvider(options: OidcProviderOptions): Promise<UpstreamOAuthProviderResult> {
  const {
    issuer,
    clientId,
    clientSecret,
    serverUrl,
    upstreamScopes = DEFAULT_UPSTREAM_SCOPES,
    grantedScopes,
    mapUserInfo,
    discoveryTtlMs,
  } = options;

  logger.info(LogMessages.CREATING, issuer);

  // Fetch OIDC discovery document (cached with TTL)
  const discovery = await getOidcDiscovery(issuer, discoveryTtlMs);

  if (!discovery.userinfo_endpoint) {
    logger.warn(LogMessages.NO_USERINFO, issuer);
  }

  logger.info(
    LogMessages.CREATED,
    discovery.authorization_endpoint,
    discovery.token_endpoint,
    discovery.userinfo_endpoint ?? "(none)",
  );

  // Default OIDC UserInfo → AuthInfo mapping
  const defaultMapUserInfo = async (token: string, data: Record<string, unknown>): Promise<AuthInfo> => {
    // @type-narrowing: OIDC UserInfo response contains standard claims
    const claims = data as unknown as OidcUserInfoClaims;

    // Validate required `sub` claim (OIDC Core §5.1) at system boundary
    if (!claims.sub || typeof claims.sub !== "string") {
      throw new Error("OIDC UserInfo response missing required 'sub' claim");
    }

    return {
      token,
      clientId: claims.sub,
      scopes: grantedScopes ? [...grantedScopes] : [],
      // SDK requireBearerAuth middleware requires expiresAt.
      // Use 1h expiry — token is re-verified via userinfo on each request.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: {
        provider: "oidc",
        issuer,
        // Validate optional claim types at system boundary — OIDC providers may return non-string values
        username: typeof claims.preferred_username === "string" ? claims.preferred_username : undefined,
        displayName:
          typeof claims.name === "string"
            ? claims.name
            : typeof claims.preferred_username === "string"
              ? claims.preferred_username
              : claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
      },
    };
  };

  return createUpstreamOAuthProvider({
    endpoints: {
      authorizationUrl: discovery.authorization_endpoint,
      tokenUrl: discovery.token_endpoint,
      userinfoUrl: discovery.userinfo_endpoint,
      revocationUrl: discovery.revocation_endpoint,
    },
    clientId,
    clientSecret,
    serverUrl,
    upstreamScopes: [...upstreamScopes],
    mapUserInfo: mapUserInfo ?? defaultMapUserInfo,
    tokenRequestContentType: "form", // OIDC standard
    upstreamAuthorizeParams: { response_type: "code" },
    refreshTokenSupport: true,
  });
}
