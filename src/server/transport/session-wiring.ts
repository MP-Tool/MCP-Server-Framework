/**
 * Shared session wiring for HTTP-based transport handlers.
 *
 * The Streamable HTTP stateful handler and the legacy SSE handler both bind a
 * connecting request's verified auth to the session and close the session on
 * client disconnect. Both bindings were historically duplicated per handler —
 * and the auth binding was independently missed (and fixed) in each one. This
 * module is the single place for that wiring so a future transport cannot
 * forget it.
 *
 * @module server/transport/session-wiring
 */

import type { Request } from "express";
import { createAuthContext } from "../auth/index.js";
import type { AuthContext } from "../auth/index.js";
import { SESSION_CLOSE_REASONS } from "../session/index.js";
import type { SessionManager } from "../session/index.js";
import type { Logger } from "../../logger/index.js";

/**
 * Build the session's `AuthContext` from the connecting request's verified
 * auth. Prefers the middleware-provided context (`req.mcp_authenticated_context`)
 * and falls back to constructing one from the SDK's `req.auth`. Returns
 * `undefined` for anonymous requests.
 */
export function buildSessionAuth(req: Request): AuthContext | undefined {
  return (
    req.mcp_authenticated_context ??
    (req.auth ? createAuthContext(req.auth, req.auth.clientId, req.auth.scopes, req.auth.extra) : undefined)
  );
}

/**
 * Close a session after a client disconnect — fire-and-forget with a warn-only
 * catch, so a failing close can never propagate into transport callbacks.
 */
export function closeSessionOnDisconnect(sessionManager: SessionManager, sessionId: string, logger: Logger): void {
  void sessionManager.close(sessionId, SESSION_CLOSE_REASONS.CLIENT_DISCONNECT).catch((err: unknown) => {
    logger.warn("Error closing session on client disconnect: %s", err instanceof Error ? err.message : String(err));
  });
}
