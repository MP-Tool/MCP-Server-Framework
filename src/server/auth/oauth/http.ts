/**
 * Shared OAuth HTTP helpers used by the upstream OAuth provider core.
 *
 * @module server/auth/oauth/http
 */

import { InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const OAUTH_FETCH_TIMEOUT_MS = 10_000;

/**
 * Asserts that a fetch Response carries a JSON Content-Type before parsing.
 * Throws a descriptive error when upstream returns HTML error pages or other
 * non-JSON bodies (e.g. from WAFs, proxies, or misconfigured endpoints).
 */
export function assertJsonContentType(response: globalThis.Response, context: string): void {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new Error(`Expected JSON from ${context}, got Content-Type: ${ct} (HTTP ${response.status})`);
  }
}

/**
 * Parses and validates a client redirect URI for the OAuth callback.
 * Accepts HTTPS (any host) or HTTP only for loopback addresses (RFC 8252 §8.3).
 * Returns the parsed URL on success, null if invalid/unsafe.
 */
export function parseClientRedirectUri(uri: string): URL | null {
  try {
    const url = new URL(uri);
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"))
    ) {
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A validated token-endpoint response. `access_token` is guaranteed to be a non-empty
 * string (enforced at runtime by {@link parseTokenResponse}); the remaining fields are
 * left untyped since they vary by provider and are read defensively at the call site.
 */
export type TokenResponse = { access_token: string } & Record<string, unknown>;

/**
 * Parses and validates a token endpoint response.
 *
 * Validates Content-Type, extracts and re-throws upstream `error` fields as
 * {@link InvalidGrantError}, and asserts `access_token` is present.
 * Use this for token exchange and refresh responses — not for userinfo endpoints.
 *
 * @param response - Fetch response from the upstream token endpoint
 * @param context - Human-readable context for error messages
 * @returns Parsed response body, with `access_token` guaranteed present
 */
export async function parseTokenResponse(response: globalThis.Response, context: string): Promise<TokenResponse> {
  assertJsonContentType(response, context);
  const data = (await response.json()) as Record<string, unknown>;
  if (data.error) {
    const errorCode = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
    const desc = typeof data.error_description === "string" ? ` — ${data.error_description}` : "";
    throw new InvalidGrantError(`Upstream ${context} error: ${errorCode}${desc}`);
  }
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new ServerError(`Upstream ${context} returned no access_token`);
  }
  return data as TokenResponse;
}

/**
 * Sends a token request to the upstream provider.
 * Supports both `application/x-www-form-urlencoded` (standard) and
 * `application/json` (GitHub) content types.
 */
export async function fetchToken(
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
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Token request to ${tokenUrl} failed: ${err instanceof Error ? err.message : "network error"}`, {
      cause: err,
    });
  }
}
