/**
 * Auth Identity
 *
 * Who a piece of auth information belongs to. Kept here so every layer answers that the same
 * way: sessions and tool calls carry differently shaped auth, and the audit trail, identity
 * stores and session checks must still agree on one principal.
 *
 * @module utils/auth-identity
 */

/**
 * The shapes auth information arrives in: `ToolContext.auth`, the session's `AuthContext`, or
 * anything else that carries a resolved `userId`.
 */
export interface AuthIdentitySource {
  readonly userId?: string | undefined;
  readonly authInfo?: { readonly clientId?: string | undefined } | undefined;
  readonly sdkAuthInfo?: { readonly clientId?: string | undefined } | undefined;
}

/**
 * The stable principal id: the resolved user when there is one, otherwise the OAuth client.
 *
 * @returns The id, or `undefined` for anonymous access
 */
export function authIdentityKey(auth: AuthIdentitySource | undefined): string | undefined {
  return auth?.userId ?? auth?.authInfo?.clientId ?? auth?.sdkAuthInfo?.clientId ?? undefined;
}

/** The conventional `username` label from an auth `extra` payload, if present. */
export function authUsername(extra: Record<string, unknown> | undefined): string | undefined {
  return typeof extra?.["username"] === "string" ? extra["username"] : undefined;
}
