/**
 * OAuth Module — internal barrel.
 *
 * Re-exports the public OAuth API consumed by {@link ../index.ts auth/index.ts}:
 * the unified {@link createOAuthProvider} factory, its config/option types, the
 * provider-identity/hook types, and the OIDC discovery utilities.
 *
 * The protocol engine (`core.ts`), presets (`presets.ts`), and HTTP/state helpers
 * are internal and not re-exported from the package barrel.
 *
 * @module server/auth/oauth
 */

export { createOAuthProvider, authInfoExpiry } from "./provider.js";
export type {
  OAuthProviderConfig,
  GithubProviderConfig,
  GoogleProviderConfig,
  OidcProviderConfig,
  OAuth2ProviderConfig,
  CreateOAuthProviderOptions,
} from "./provider.js";

export type {
  OAuthProviderResult,
  OAuthProviderType,
  ProviderContext,
  MapUserInfo,
  OnTokenExchanged,
  UpstreamEndpoints,
  LocalLoginConfig,
} from "./core.js";

export { fetchOidcDiscovery, getOidcDiscovery, clearOidcDiscoveryCache } from "./discovery.js";
export type { OidcDiscoveryDocument } from "./discovery.js";
// resolveOidcEndpoints: used only within oauth/ — not re-exported
