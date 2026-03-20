/**
 * Auth Module
 *
 * Authentication and authorization for MCP sessions.
 * Provides OAuth 2.1 integration per MCP specification, token verification,
 * auth context for sessions, and guard functions for tool handlers.
 *
 * @module server/auth
 */

// Auth Context
export type { AuthInfo, AuthContext } from "./auth-context.js";
export { ANONYMOUS_AUTH, createAuthContext } from "./auth-context.js";

// Auth Types
export type { OAuthServerProvider, TokenVerifier, AuthProvider, AuthenticatedExtra, AuthOptions } from "./types.js";
export { isFullOAuthProvider } from "./types.js";

// Auth Guards
export { requireAuth, requireScope, requireScopes, hasScope, hasAllScopes, hasAnyScope } from "./guards.js";

// Upstream OAuth Provider (generic server-side callback pattern)
export { createUpstreamOAuthProvider } from "./upstream-provider.js";
export type { UpstreamOAuthOptions, UpstreamOAuthProviderResult, UpstreamEndpoints } from "./upstream-provider.js";

// OIDC Provider (auto-discovery for OIDC-compliant providers)
export { createOidcProvider } from "./oidc-provider.js";
export type { OidcProviderOptions } from "./oidc-provider.js";

// OIDC Discovery (for advanced use cases)
export { fetchOidcDiscovery, getOidcDiscovery, clearOidcDiscoveryCache } from "./oidc-discovery.js";
export type { OidcDiscoveryDocument } from "./oidc-discovery.js";
