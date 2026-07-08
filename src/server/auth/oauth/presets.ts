/**
 * OAuth Provider Presets — built-in provider definitions.
 *
 * Each preset declares everything that is specific to a provider type: default
 * scopes, token-endpoint content type, refresh support, how endpoints are resolved
 * (static vs. OIDC discovery), and the default userinfo → {@link AuthInfo} mapper.
 *
 * Adding a new built-in provider = adding one entry to {@link OAUTH_PRESETS}.
 * Pure data + mappers — no I/O. OIDC discovery is performed by the factory in
 * `./provider.ts`, driven by each preset's `resolution`.
 *
 * @module server/auth/oauth/presets
 */

import { authInfoExpiry } from "./core.js";
import type { BoundMapUserInfo, OAuthProviderType, UpstreamEndpoints } from "./core.js";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_OIDC_SCOPES = ["openid", "email", "profile"] as const;
export const DEFAULT_GITHUB_SCOPES = ["read:user", "user:email"] as const;

export const GITHUB_ENDPOINTS: UpstreamEndpoints = {
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userinfoUrl: "https://api.github.com/user",
};

export const GOOGLE_DEFAULT_ISSUER = "https://accounts.google.com";

/** Preset type token (everything except the `oauth2` escape hatch, which has no preset). */
export type PresetProviderType = Exclude<OAuthProviderType, "oauth2">;

// ============================================================================
// Default UserInfo Mappers
// ============================================================================

/**
 * Standard OIDC UserInfo claims.
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
 * Builds the default OIDC userinfo mapper. Validates the required `sub` claim
 * (OIDC Core §5.1) and maps standard claims into {@link AuthInfo}.
 */
function buildOidcMapUserInfo(
  providerType: "google" | "oidc",
  issuer: string | undefined,
  grantedScopes: readonly string[] | undefined,
): BoundMapUserInfo {
  return async (token, data) => {
    // @type-narrowing: OIDC UserInfo response contains standard claims
    const claims = data as unknown as OidcUserInfoClaims;

    // Validate required `sub` claim at system boundary
    if (!claims.sub || typeof claims.sub !== "string") {
      throw new Error("OIDC UserInfo response missing required 'sub' claim");
    }

    return {
      token,
      clientId: claims.sub,
      scopes: grantedScopes ? [...grantedScopes] : [],
      expiresAt: authInfoExpiry(),
      extra: {
        provider: providerType,
        ...(issuer !== undefined && { issuer }),
        // Validate optional claim types at system boundary — providers may return non-string values
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
}

/** Default GitHub userinfo mapper — maps `login`/`sub` to clientId. */
const githubMapUserInfo: BoundMapUserInfo = async (token, data) => {
  const login = data["login"];
  const sub = data["sub"];
  const clientId = typeof login === "string" ? login : typeof sub === "string" ? sub : "unknown";
  return {
    token,
    clientId,
    scopes: [],
    expiresAt: authInfoExpiry(),
    extra: { provider: "github" },
  };
};

// ============================================================================
// Presets
// ============================================================================

/** A built-in provider definition. */
export interface OAuthPreset {
  readonly type: PresetProviderType;
  readonly defaultDisplayName: string;
  readonly defaultScopes: readonly string[];
  readonly tokenRequestContentType: "form" | "json";
  readonly refreshTokenSupport: boolean;
  readonly upstreamAuthorizeParams?: Readonly<Record<string, string>>;
  /**
   * Endpoint resolution strategy:
   * - `static` — endpoints are known ahead of time (e.g. GitHub).
   * - `oidc`   — endpoints are discovered from `{issuer}/.well-known/openid-configuration`;
   *              `defaultIssuer` is used when the config omits one (e.g. Google).
   */
  readonly resolution:
    | { readonly kind: "static"; readonly endpoints: UpstreamEndpoints }
    | { readonly kind: "oidc"; readonly defaultIssuer?: string };
  /** Builds the preset's default userinfo mapper for a resolved provider. */
  readonly buildDefaultMapUserInfo: (params: {
    readonly issuer?: string;
    readonly grantedScopes?: readonly string[];
  }) => BoundMapUserInfo;
}

export const OAUTH_PRESETS: Record<PresetProviderType, OAuthPreset> = {
  github: {
    type: "github",
    defaultDisplayName: "GitHub",
    defaultScopes: DEFAULT_GITHUB_SCOPES,
    tokenRequestContentType: "json", // GitHub's token endpoint accepts JSON, not form-encoded
    refreshTokenSupport: false,
    upstreamAuthorizeParams: { response_type: "code" },
    resolution: { kind: "static", endpoints: GITHUB_ENDPOINTS },
    buildDefaultMapUserInfo: () => githubMapUserInfo,
  },
  google: {
    type: "google",
    defaultDisplayName: "Google",
    defaultScopes: DEFAULT_OIDC_SCOPES,
    tokenRequestContentType: "form",
    refreshTokenSupport: true,
    upstreamAuthorizeParams: { response_type: "code" },
    resolution: { kind: "oidc", defaultIssuer: GOOGLE_DEFAULT_ISSUER },
    buildDefaultMapUserInfo: ({ issuer, grantedScopes }) => buildOidcMapUserInfo("google", issuer, grantedScopes),
  },
  oidc: {
    type: "oidc",
    defaultDisplayName: "OIDC",
    defaultScopes: DEFAULT_OIDC_SCOPES,
    tokenRequestContentType: "form",
    refreshTokenSupport: true,
    upstreamAuthorizeParams: { response_type: "code" },
    resolution: { kind: "oidc" },
    buildDefaultMapUserInfo: ({ issuer, grantedScopes }) => buildOidcMapUserInfo("oidc", issuer, grantedScopes),
  },
};
