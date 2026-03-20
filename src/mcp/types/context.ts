/**
 * Tool Context Types
 *
 * Context interface passed to tool handlers during execution.
 * Bridges between the MCP SDK's RequestHandlerExtra and our clean handler API.
 *
 * The SDK provides raw protocol details (signal, sendNotification, _meta, etc.).
 * This module defines a clean, ergonomic interface that frameworks consumers use,
 * while the framework internally maps SDK extra → ToolContext.
 *
 * @see https://spec.modelcontextprotocol.io/specification/server/utilities/progress/
 * @see https://spec.modelcontextprotocol.io/specification/basic/cancellation/
 *
 * @module mcp/types/context
 */

import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageRequestParamsBase,
  Root,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Progress Reporting Types (MCP Specification)
// ============================================================================

/**
 * Progress data for long-running operations.
 *
 * Per MCP specification, progress notifications allow tools to report
 * incremental progress during long-running operations. The client
 * initiates progress tracking by including a `progressToken` in the
 * `_meta` field of the request.
 *
 * @see MCP Specification - notifications/progress
 *
 * @example
 * ```typescript
 * // Determinate progress (e.g., processing 50 of 100 items)
 * { progress: 50, total: 100, message: 'Processing item 50...' }
 *
 * // Indeterminate progress (total unknown)
 * { progress: 3, message: 'Fetching data...' }
 * ```
 */
export interface ProgressData {
  /**
   * Current progress value.
   *
   * Should be monotonically increasing. If `total` is set, must be <= total.
   * The value itself carries no specific meaning - only relative progress matters.
   */
  readonly progress: number;

  /**
   * Total expected value for determinate progress.
   *
   * When set, `progress / total` represents completion percentage.
   * Omit for indeterminate progress (spinner-style).
   */
  readonly total?: number;

  /**
   * Human-readable progress message.
   *
   * Optional description of current operation state.
   * Useful for providing context to the user/LLM.
   */
  readonly message?: string;
}

/**
 * Progress reporter function type.
 *
 * Sends MCP `notifications/progress` to the client.
 *
 * @param data - Progress data to report
 * @returns true if notification was sent, false if no progressToken or failed
 */
export type ProgressReporter = (data: ProgressData) => Promise<boolean>;

// ============================================================================
// Tool Context Interface
// ============================================================================

/**
 * Context passed to tool handlers during execution.
 *
 * Provides MCP-compliant mechanisms for:
 * - **Progress Reporting**: Send incremental updates during long operations
 * - **Cancellation**: Gracefully abort when client sends cancellation
 * - **Session Identity**: Identify which client session invoked the tool
 *
 * All features are sourced from the SDK's `RequestHandlerExtra` and mapped
 * to this clean interface by the framework. Cancellation uses the SDK's
 * native AbortSignal (per-request, automatically aborted on `notifications/cancelled`).
 *
 * @example
 * ```typescript
 * defineTool({
 *   name: 'process-batch',
 *   description: 'Process items with progress',
 *   input: z.object({ items: z.array(z.string()) }),
 *   handler: async ({ items }, context) => {
 *     const total = items.length;
 *
 *     for (let i = 0; i < items.length; i++) {
 *       // Check for cancellation (MCP notifications/cancelled)
 *       if (context.abortSignal.aborted) {
 *         return error(`Cancelled after ${i} items`);
 *       }
 *
 *       // Report progress (MCP notifications/progress)
 *       await context.reportProgress?.({
 *         progress: i + 1,
 *         total,
 *         message: `Processing ${items[i]}...`
 *       });
 *
 *       await processItem(items[i]);
 *     }
 *
 *     return text(`Processed ${total} items`);
 *   },
 * });
 * ```
 */
export interface ToolContext {
  /**
   * Reports progress for long-running operations.
   *
   * **MCP Protocol**: Sends `notifications/progress` to the client.
   *
   * Only available if the MCP client requested progress tracking by
   * including `_meta.progressToken` in the `tools/call` request.
   * If not requested, this will be `undefined`.
   *
   * The framework applies rate-limiting (100ms minimum interval) to
   * prevent flooding the client with notifications.
   *
   * @param data - Progress data to report
   * @returns true if notification was sent successfully, false if rate-limited
   */
  readonly reportProgress?: ProgressReporter | undefined;

  /**
   * AbortSignal that triggers when the request is cancelled.
   *
   * **MCP Protocol**: Triggered when client sends `notifications/cancelled`
   * with a matching `requestId`. This is the SDK's native AbortSignal,
   * created per-request and managed by the MCP protocol layer.
   *
   * Tools SHOULD check this signal periodically during long-running
   * operations and abort gracefully when triggered.
   *
   * @example
   * ```typescript
   * // Check before expensive operations
   * if (context.abortSignal.aborted) {
   *   throw new Error('Operation cancelled');
   * }
   *
   * // Pass signal to fetch/other APIs that support it
   * const response = await fetch(url, { signal: context.abortSignal });
   * ```
   */
  readonly abortSignal: AbortSignal;

  /**
   * The JSON-RPC request ID for this tool call.
   *
   * Useful for logging, tracing, and correlating requests.
   * This is the real protocol-level request ID from the MCP client.
   */
  readonly requestId: string | number;

  /**
   * The session ID from the transport, if available.
   *
   * Identifies which MCP client session invoked this tool.
   * Available in HTTP transport mode (Streamable HTTP, SSE), not in stdio.
   */
  readonly sessionId?: string | undefined;

  /**
   * Whether this tool is executing in stateless mode.
   *
   * In stateless mode, the server creates a fresh session per request —
   * no persistent state is maintained between calls.
   *
   * **Per-request features** (work normally in stateless):
   * - Progress reporting via SSE events in the POST response stream
   * - AbortSignal (client closes connection → transport detects)
   * - Logging notifications in the response stream
   *
   * **Cross-request features** (unavailable in stateless by design):
   * - Protocol cancellation (`notifications/cancelled`) — needs routing to original session
   * - Sampling (`sampling/createMessage`) — server→client requires persistent channel
   * - Elicitation (`elicitation/create`) — server→client requires persistent channel
   * - Roots (`roots/list`) — server→client requires persistent channel
   * - GET SSE streams and DELETE — no session ID for association
   *
   * Tools MAY use this flag to adapt behavior for cross-request limitations,
   * e.g., avoiding operations that rely on server-initiated client requests.
   *
   * @see DD-019 for the design rationale behind these limitations
   */
  readonly stateless: boolean;

  /**
   * Request LLM sampling from the client.
   *
   * **MCP Protocol**: Sends a `sampling/createMessage` request to the client,
   * which returns an LLM-generated response. This enables server-initiated
   * LLM interactions (e.g., asking the LLM to summarize data for the user).
   *
   * **Availability**: Only present when the client declares `sampling` capability
   * AND the session is stateful. In stateless mode or when the client doesn't
   * support sampling, this will be `undefined`.
   *
   * @param params - Sampling request parameters (messages, model preferences, etc.)
   * @returns The LLM's response with model info and stop reason
   *
   * @example
   * ```typescript
   * if (context.createMessage) {
   *   const result = await context.createMessage({
   *     messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this data' } }],
   *     maxTokens: 500,
   *   });
   *   // result.content, result.model, result.stopReason
   * }
   * ```
   */
  readonly createMessage?: (
    params: CreateMessageRequestParamsBase | CreateMessageRequest["params"],
  ) => Promise<CreateMessageResult> | undefined;

  /**
   * List the client's root URIs.
   *
   * **MCP Protocol**: Sends a `roots/list` request to the client, which returns
   * the set of root URIs (workspace folders, project roots, etc.) the client
   * has made available to the server.
   *
   * **Availability**: Only present when the client declares `roots` capability
   * AND the session is stateful. In stateless mode or when the client doesn't
   * support roots, this will be `undefined`.
   *
   * @returns Array of root objects with URI and optional name
   *
   * @example
   * ```typescript
   * if (context.listRoots) {
   *   const { roots } = await context.listRoots();
   *   for (const root of roots) {
   *     console.log(`Root: ${root.uri} (${root.name})`);
   *   }
   * }
   * ```
   */
  readonly listRoots?: (() => Promise<{ roots: Root[] }>) | undefined;

  /**
   * Request user input via the client's elicitation UI.
   *
   * **MCP Protocol**: Sends an `elicitation/create` request to the client,
   * which presents a form or URL to the user and returns their input.
   *
   * **Availability**: Only present when the client declares `elicitation` capability
   * AND the session is stateful. In stateless mode or when the client doesn't
   * support elicitation, this will be `undefined`.
   *
   * @param params - Elicitation parameters (form schema or URL)
   * @returns User's response (accept/decline/cancel with optional content)
   *
   * @example
   * ```typescript
   * if (context.elicitInput) {
   *   const result = await context.elicitInput({
   *     message: 'Please confirm the deployment target',
   *     requestedSchema: {
   *       type: 'object',
   *       properties: {
   *         confirmed: { type: 'boolean', title: 'Confirm deployment' },
   *       },
   *     },
   *   });
   *   if (result.action === 'accept') {
   *     // result.content contains the form values
   *   }
   * }
   * ```
   */
  readonly elicitInput?: (
    params: ElicitRequestFormParams | ElicitRequestURLParams,
  ) => Promise<ElicitResult> | undefined;

  /**
   * Authentication context for the current request.
   *
   * Available when auth middleware is configured on the server.
   * Contains the verified token info (`authInfo`) and optional
   * consumer-provided data (`extra`) from the `onAuthenticated` hook.
   *
   * `undefined` when no auth is configured (anonymous access).
   *
   * @example
   * ```typescript
   * handler: async (args, ctx) => {
   *   if (ctx.auth) {
   *     const { clientId, scopes } = ctx.auth.authInfo;
   *     const role = ctx.auth.extra?.role;
   *   }
   *   return text('OK');
   * }
   * ```
   */
  readonly auth?:
    | {
        /** Verified auth info from the Bearer token */
        readonly authInfo: AuthInfo;
        /** Consumer-provided extra data from `onAuthenticated` hook */
        readonly extra?: Record<string, unknown> | undefined;
      }
    | undefined;
}

// ============================================================================
// Task Tool Context Types (Experimental — Async Tool Execution)
// ============================================================================

/**
 * Context passed to `taskHandler.createTask()` when initiating a new task.
 *
 * Extends the base tool context with access to the task store for creating
 * and managing tasks. The task store is provided by the SDK and handles
 * task ID generation, status tracking, and result storage.
 *
 * @experimental MCP Tasks is an experimental SDK feature
 *
 * @example
 * ```typescript
 * createTask: async (args, ctx) => {
 *   const task = await ctx.taskStore.createTask({ ttl: 300_000 });
 *   startBackgroundWork(task.taskId, args);
 *   return { task };
 * },
 * ```
 */
export interface TaskCreateContext extends ToolContext {
  /**
   * Request-scoped task store for creating and managing tasks.
   *
   * Provided by the SDK. The default implementation is `InMemoryTaskStore`.
   * Custom implementations (Redis, PostgreSQL) can be provided via server options.
   */
  readonly taskStore: RequestTaskStore;
}

/**
 * Context passed to `taskHandler.getTask()` and `taskHandler.getTaskResult()`.
 *
 * Extends the base tool context with the task ID of the task being queried
 * and access to the task store for retrieving task status and results.
 *
 * @experimental MCP Tasks is an experimental SDK feature
 *
 * @example
 * ```typescript
 * getTask: async (_args, ctx) => {
 *   return ctx.taskStore.getTask(ctx.taskId);
 * },
 * getTaskResult: async (_args, ctx) => {
 *   return ctx.taskStore.getTaskResult(ctx.taskId);
 * },
 * ```
 */
export interface TaskOperationContext extends ToolContext {
  /** The task ID being queried */
  readonly taskId: string;

  /**
   * Request-scoped task store for retrieving task status and results.
   */
  readonly taskStore: RequestTaskStore;
}

// ============================================================================
// Internal Types (used by framework handlers)
// ============================================================================

/**
 * Function that sends an MCP notification.
 *
 * Typed using the SDK's `ServerNotification` discriminated union which
 * includes `ProgressNotification`, `LoggingMessageNotification`, etc.
 * The framework constructs valid progress notifications internally.
 *
 * @internal Used by progress handler — not for application code.
 */
export type SendNotificationFn = (notification: ServerNotification) => Promise<void>;

/**
 * Progress token type from MCP specification.
 * Can be string or number.
 *
 * @internal Used by progress handler — not for application code.
 */
export type ProgressToken = string | number;
