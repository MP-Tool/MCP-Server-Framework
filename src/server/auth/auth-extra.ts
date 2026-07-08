/**
 * Typed `auth.extra` binding.
 *
 * The framework carries consumer-defined data on the `extra` field of `AuthInfo` /
 * `AuthContext` / `ToolContext.auth`. This module provides a small, type-safe codec so
 * consumers stop hand-casting `auth.extra["x"] as string | undefined`.
 *
 * A binding pairs a runtime type guard with read/write helpers and works uniformly across
 * every place `extra` surfaces — so the same accessor reads a stateful `session.auth` and a
 * per-request `ToolContext.auth` (stateless) alike.
 *
 * @example
 * ```ts
 * interface SessionCreds { provider: string; serviceJwt?: string }
 * const creds = defineAuthExtra<SessionCreds>((e) => typeof e["provider"] === "string");
 *
 * // when producing auth (e.g. inside mapUserInfo):
 * return { token, clientId, scopes, extra: creds.write({ provider: "google", serviceJwt }) };
 *
 * // when consuming auth (tool handler, both transports):
 * const c = creds.read(ctx.auth);   // SessionCreds | undefined
 * ```
 *
 * @module server/auth/auth-extra
 */

/** Anything that carries an optional `extra` bag — `AuthInfo`, `AuthContext`, `ToolContext.auth`. */
export interface HasAuthExtra {
  readonly extra?: Record<string, unknown> | undefined;
}

/** A typed read/write codec for a specific `auth.extra` shape. */
export interface AuthExtraBinding<T extends object> {
  /** Builds an `extra` bag from a typed value (use in `mapUserInfo` / `createAuthContext`). */
  write(value: T): Record<string, unknown>;
  /** Reads the typed value from any auth-like carrier; `undefined` when absent or failing the guard. */
  read(source: HasAuthExtra | undefined): T | undefined;
}

/**
 * Defines a typed binding for an `auth.extra` payload.
 *
 * @param guard - Runtime predicate identifying a valid payload (checked in {@link AuthExtraBinding.read})
 * @returns A {@link AuthExtraBinding} with `read`/`write` helpers
 */
export function defineAuthExtra<T extends object>(
  guard: (extra: Record<string, unknown>) => boolean,
): AuthExtraBinding<T> {
  return {
    write(value: T): Record<string, unknown> {
      return { ...value } as Record<string, unknown>;
    },
    read(source: HasAuthExtra | undefined): T | undefined {
      const extra = source?.extra;
      if (extra && guard(extra)) {
        return extra as T;
      }
      return undefined;
    },
  };
}
