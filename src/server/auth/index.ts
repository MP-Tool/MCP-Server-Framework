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

// OAuth Provider
export { createOAuthProvider, authInfoExpiry } from "./oauth/index.js";
export type {
  OAuthProviderConfig,
  GithubProviderConfig,
  GoogleProviderConfig,
  OidcProviderConfig,
  OAuth2ProviderConfig,
  CreateOAuthProviderOptions,
  OAuthProviderResult,
  OAuthProviderType,
  ProviderContext,
  MapUserInfo,
  OnTokenExchanged,
  UpstreamEndpoints,
  LocalLoginConfig,
} from "./oauth/index.js";

// Login page rendering (custom branding via LoginPageRenderer)
export type { LoginPageRenderer, SelectableProvider, LocalLoginForm } from "./login.js";

// OAuth Discovery
export { fetchOidcDiscovery, getOidcDiscovery, clearOidcDiscoveryCache } from "./oauth/index.js";
export type { OidcDiscoveryDocument } from "./oauth/index.js";

// Browser-based OAuth/OIDC login (interactive, for stdio-mode servers)
export { createBrowserOAuthLogin, deriveServerBaseUrl } from "./browser-login.js";
export type {
  BrowserOAuthLogin,
  BrowserOAuthConfig,
  BrowserOAuthResult,
  BrowserOAuthProvider,
} from "./browser-login.js";

// Declarative OAuth config resolution (generic [auth] section → provider configs)
export { resolveAuthConfig, toOAuthProviderConfigs } from "./auth-config.js";
export type { ResolvedAuthConfig, AuthProviderInput } from "./auth-config.js";
