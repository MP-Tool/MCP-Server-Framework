/**
 * Per-tool-call context accessor via AsyncLocalStorage.
 *
 * The framework sets this automatically before each tool handler runs.
 * Consumers call `getCurrentToolContext()` from anywhere in the call stack
 * (helpers, connection managers, etc.) without threading ctx as a parameter.
 *
 * @module mcp/current-tool-context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolContext } from "./types/context.js";

const toolContextStorage = new AsyncLocalStorage<ToolContext>();

/**
 * Returns the ToolContext for the currently executing tool call, or `undefined`
 * when called outside a tool handler (e.g. startup, background tasks).
 */
export function getCurrentToolContext(): ToolContext | undefined {
  return toolContextStorage.getStore();
}

/**
 * Runs `fn` with `ctx` available via `getCurrentToolContext()`.
 * Used internally by the framework's tool registry — not for application code.
 *
 * @internal
 */
export function runWithToolContext<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return toolContextStorage.run(ctx, fn);
}
