/**
 * Auth Middleware — unified token authentication.
 *
 * A single factory that covers every server-side token-auth pattern via two
 * orthogonal options:
 *
 * - **token source** — `"bearer"` (`Authorization: Bearer`) or a custom header (e.g. `X-API-Key`).
 * - **enforcement** — `"required"` (reject with 401/403) or `"optional"` (fall through as anonymous).
 *
 * On success the verified {@link AuthInfo} is attached to `req.auth`, matching the
 * contract of the SDK's bearer-auth middleware. The framework's session layer turns
 * `req.auth` into an {@link AuthContext} during session creation.
 *
 * The standard `required` + `bearer` case delegates to the SDK's `requireBearerAuth`
 * so the RFC 6750 / RFC 9728 `WWW-Authenticate` discovery behavior stays spec-compliant.
 * All other combinations share one generic verification core.
 *
 * @module server/middleware/auth-middleware
 */

import type { RequestHandler, Request, Response, NextFunction } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import type { AuthContext } from "../auth/auth-context.js";
import type { AuthInfo, AuthenticatedExtra, AuthProvider } from "../auth/types.js";
import { isFullOAuthProvider } from "../auth/types.js";
import { createJsonRpcError, HttpStatus, JsonRpcErrorCode } from "../../errors/index.js";
import { logger as baseLogger } from "../../logger/index.js";
import { logSecurityEvent } from "./logging.js";

// `req.auth` is augmented onto Express by the SDK's bearer-auth module (imported above).
// We add the legacy consumer seam used to inject a pre-built AuthContext (e.g. Komodo's
// OIDC bridge); it is read during session creation in the stateful HTTP handler.
declare module "express-serve-static-core" {
  interface Request {
    /** Pre-built auth context set by consumer middleware; read during session creation. */
    mcp_authenticated_context?: AuthContext;
  }
}

// ============================================================================
// Logger & Constants
// ============================================================================

const LOG_COMPONENT = "auth-middleware";

const LogMessages = {
  CONFIGURED: "Auth middleware configured (source: %s, enforcement: %s, scopes: %s)",
  VERIFY_ERROR: "Token verification threw: %s",
  HOOK_ERROR: "onAuthenticated hook threw — continuing without extra: %s",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

/** Maximum accepted token length. Longer values are rejected before any verifier call. */
const MAX_TOKEN_LENGTH = 4096;

// ============================================================================
// Types
// ============================================================================

/** Where the access token is read from. */
export type AuthTokenSource = "bearer" | { readonly header: string };

/** What happens when a token is missing or invalid. */
export type AuthEnforcement = "required" | "optional";

/** Options for {@link createAuthMiddleware}. */
export interface AuthMiddlewareOptions {
  /** Authentication provider (full OAuth provider or a token verifier). */
  readonly provider: AuthProvider;

  /** Token source. @default "bearer" */
  readonly tokenSource?: AuthTokenSource | undefined;

  /** Enforcement mode. @default "required" */
  readonly enforcement?: AuthEnforcement | undefined;

  /**
   * Required scopes. Requests whose token lacks ALL listed scopes are rejected with 403
   * (`required`) or treated as anonymous (`optional`).
   */
  readonly requiredScopes?: readonly string[] | undefined;

  /**
   * Protected Resource Metadata URL (RFC 9728), included in `WWW-Authenticate` headers.
   * Only meaningful for the `bearer` + `required` combination.
   */
  readonly resourceMetadataUrl?: string | undefined;

  /**
   * Hook called after successful verification. Its result is merged into `req.auth.extra`.
   * If it throws, the error is logged and the request continues with the original `extra`
   * (hook errors never fail a valid session).
   */
  readonly onAuthenticated?: ((authInfo: AuthInfo) => Promise<AuthenticatedExtra | undefined>) | undefined;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extracts a Bearer token from an `Authorization` header value.
 *
 * @param authHeader - The raw `Authorization` header value
 * @returns The token if the header is a well-formed `Bearer <token>`, else `undefined`
 */
export function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  return match ? match[1] : undefined;
}

/** Adapts an {@link AuthProvider} to the minimal `{ verifyAccessToken }` verifier shape. */
function toVerifier(provider: AuthProvider): { verifyAccessToken: (token: string) => Promise<AuthInfo> } {
  return isFullOAuthProvider(provider) ? provider : { verifyAccessToken: provider.verifyAccessToken.bind(provider) };
}

/** Returns the required scopes missing from the token (empty if none required or all present). */
function missingScopes(authInfo: AuthInfo, scopeList: readonly string[] | undefined): string[] {
  if (!scopeList || scopeList.length === 0) return [];
  return scopeList.filter((s) => !authInfo.scopes.includes(s));
}

/**
 * Runs the `onAuthenticated` hook and merges its result into `authInfo.extra`.
 * Never throws — hook errors are logged and the original `authInfo` is returned.
 */
async function applyOnAuthenticated(
  authInfo: AuthInfo,
  hook: AuthMiddlewareOptions["onAuthenticated"],
): Promise<AuthInfo> {
  if (!hook) return authInfo;
  try {
    const extra = await hook(authInfo);
    if (extra) return { ...authInfo, extra: { ...(authInfo.extra ?? {}), ...extra } };
  } catch (err) {
    logger.warn(LogMessages.HOOK_ERROR, err instanceof Error ? err.message : String(err));
  }
  return authInfo;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an auth middleware for the given token source and enforcement mode.
 *
 * @param options - Auth configuration
 * @returns Express middleware that sets `req.auth` on success
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): RequestHandler {
  const { provider, requiredScopes, resourceMetadataUrl, onAuthenticated } = options;
  const tokenSource: AuthTokenSource = options.tokenSource ?? "bearer";
  const enforcement: AuthEnforcement = options.enforcement ?? "required";
  const scopeList = requiredScopes ? [...requiredScopes] : undefined;

  const sourceLabel = tokenSource === "bearer" ? "bearer" : `header:${tokenSource.header}`;
  logger.info(LogMessages.CONFIGURED, sourceLabel, enforcement, scopeList?.join(", ") ?? "none");

  // The standard OAuth resource-server case — delegate to the SDK to keep RFC 6750 / 9728
  // WWW-Authenticate discovery intact, then layer the onAuthenticated hook on top.
  if (tokenSource === "bearer" && enforcement === "required") {
    return createSdkBearerMiddleware(provider, scopeList, resourceMetadataUrl, onAuthenticated);
  }

  return createGenericAuthMiddleware(provider, tokenSource, enforcement, scopeList, onAuthenticated);
}

/** `required` + `bearer`: SDK bearer auth + optional `onAuthenticated` post-processing. */
function createSdkBearerMiddleware(
  provider: AuthProvider,
  scopeList: string[] | undefined,
  resourceMetadataUrl: string | undefined,
  onAuthenticated: AuthMiddlewareOptions["onAuthenticated"],
): RequestHandler {
  const sdkMiddleware = requireBearerAuth({
    verifier: toVerifier(provider),
    ...(scopeList && scopeList.length > 0 && { requiredScopes: scopeList }),
    ...(resourceMetadataUrl && { resourceMetadataUrl }),
  });

  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        logSecurityEvent(`Auth rejected: ${res.statusCode}`, {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
        });
      }
    });

    if (!onAuthenticated) {
      sdkMiddleware(req, res, next);
      return;
    }

    // Intercept next() so the hook runs after the SDK sets req.auth.
    sdkMiddleware(req, res, (err?: unknown) => {
      const authInfo = req.auth;
      if (err || !authInfo) {
        next(err);
        return;
      }
      void (async () => {
        req.auth = await applyOnAuthenticated(authInfo, onAuthenticated);
        next();
      })();
    });
  };
}

/** Generic core for `required`+header and `optional`+(bearer|header). */
function createGenericAuthMiddleware(
  provider: AuthProvider,
  tokenSource: AuthTokenSource,
  enforcement: AuthEnforcement,
  scopeList: string[] | undefined,
  onAuthenticated: AuthMiddlewareOptions["onAuthenticated"],
): RequestHandler {
  const verifier = toVerifier(provider);
  const isBearer = tokenSource === "bearer";
  const optional = enforcement === "optional";
  const headerName = tokenSource === "bearer" ? "authorization" : tokenSource.header.toLowerCase();
  const missingTokenMsg =
    tokenSource === "bearer" ? "Missing or malformed Authorization header" : `Missing ${tokenSource.header} header`;

  return async (req: Request, res: Response, next: NextFunction) => {
    /** Reject (required) or fall through as anonymous (optional). */
    const fail = (status: number, message: string): void => {
      if (optional) {
        next();
        return;
      }
      logSecurityEvent(`Auth rejected: ${status}`, { method: req.method, path: req.path, statusCode: status });
      res.status(status).json(createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, message));
    };

    const raw = req.headers[headerName];
    const headerValue = typeof raw === "string" ? raw : undefined;
    const token = isBearer ? extractBearerToken(headerValue) : headerValue;

    if (!token) {
      fail(HttpStatus.UNAUTHORIZED, missingTokenMsg);
      return;
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      fail(HttpStatus.UNAUTHORIZED, "Invalid or expired token");
      return;
    }

    let authInfo: AuthInfo;
    try {
      authInfo = await verifier.verifyAccessToken(token);
    } catch (err) {
      logger.debug(LogMessages.VERIFY_ERROR, err instanceof Error ? err.message : String(err));
      fail(HttpStatus.UNAUTHORIZED, "Invalid or expired token");
      return;
    }

    const missing = missingScopes(authInfo, scopeList);
    if (missing.length > 0) {
      fail(HttpStatus.FORBIDDEN, `Missing required scopes: ${missing.join(", ")}`);
      return;
    }

    req.auth = await applyOnAuthenticated(authInfo, onAuthenticated);
    next();
  };
}
