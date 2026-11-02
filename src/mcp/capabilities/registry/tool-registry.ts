/**
 * Tool Registry
 *
 * Global registry for MCP tools that implements ToolProvider interface.
 * Extends BaseRegistry for common CRUD operations and provides SDK binding.
 *
 * The registry is the single authority for tool definitions:
 * - Storage: CRUD operations via BaseRegistry
 * - SDK Binding: `bindToSdk()` registers tools with MCP SDK server instances
 *
 * @module mcp/capabilities/registry/tool-registry
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra, RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { z } from "zod";

import type { ToolDefinition, ToolContext, ToolProvider, AuditToolIoLevel } from "../../types/index.js";
import { createProgressReporter } from "../../handlers/index.js";
import { SecretScrubber } from "../../../logger/index.js";
import { mcpLogger } from "../../../logger/index.js";
import { scrubCallToolResult, scrubThrownError } from "./result-scrub.js";
import type { LogNotificationHandler } from "../../../logger/core/index.js";
import { withExtendedContext } from "../../../logger/core/context.js";
import { JsonRpcErrorCode, AppError } from "../../../errors/index.js";
import { withSpan, MCP_ATTRIBUTES, SpanKind } from "../../../telemetry/index.js";
import { getServerMetrics } from "../../../telemetry/metrics.js";
import { BaseRegistry } from "./base-registry.js";
import type { ScrubbingBindOptions } from "./base-registry.js";
import { authUsername, enforceScopeOrThrow, scopeSubject } from "./scope-enforcement.js";
import { runWithToolContext } from "../../current-tool-context.js";
import { logAuditEvent } from "../../../logger/audit/index.js";

// ============================================================================
// Constants
// ============================================================================

const SdkBindingMessages = {
  TOOLS_REGISTERED: "Registered %d tools with SDK",
  TOOL_REGISTERED: "Registered tool: %s",
  NO_TOOLS: "No tools to register",
  TOOL_EXECUTING: "Tool [%s] executing",
  TOOL_COMPLETED: "Tool [%s] completed in %dms",
  TOOL_CANCELLED: "Tool [%s] cancelled",
  TOOL_ERROR: "Error executing %s:",
  REQUEST_CANCELLED_BEFORE: "Request was cancelled before execution",
  REQUEST_CANCELLED: "Request was cancelled",
} as const;

// ============================================================================
// SDK Binding Options
// ============================================================================

/**
 * Options for binding tools to an MCP SDK server. Tools can opt out of result
 * scrubbing individually via `ToolDefinition.scrubResult: false`.
 * @internal
 */
export interface ToolBindOptions extends ScrubbingBindOptions {
  readonly stateless: boolean;
  /**
   * Whether the transport answers with plain JSON instead of an SSE stream. Decides how a tool's
   * client requests (elicitation, sampling, roots) reach the client.
   */
  readonly jsonResponse?: boolean | undefined;
  /** Session-level notification handler for bridging framework logs → MCP notifications/message */
  readonly logNotificationHandler?: LogNotificationHandler | undefined;
  /**
   * How much request/response detail the per-call `tool.call` audit records
   * (always secret-scrubbed). Defaults to `"summary"` when omitted.
   */
  readonly auditToolIo?: AuditToolIoLevel | undefined;
}

/** The SDK's `extra` argument of a tool callback. */
type SdkToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** What every call of a bound tool shares. */
interface ToolCallBinding extends ToolBindOptions {
  readonly sdk: McpServer;
  readonly auditToolIo: AuditToolIoLevel;
  /** Bridges framework logs to MCP notifications; unset when the session has no handler. */
  readonly sendMcpLog: ReturnType<typeof mcpLogger.createContextLogger> | undefined;
}

/** One call of a tool. */
interface ToolCall {
  readonly tool: ToolDefinition;
  readonly args: Record<string, unknown>;
  readonly context: ToolContext;
  /** Domain detail the handler recorded, merged into the `tool.call` audit record. */
  readonly auditDetail: Record<string, unknown>;
}

// ============================================================================
// Audit Helpers
// ============================================================================

/** Max serialized size (chars) of the `full`-level result body before it is truncated. */
const AUDIT_RESULT_MAX_CHARS = 8_192;

/** Lazily-created base scrubber used for the audit when result scrubbing is disabled. */
let baseAuditScrubber: SecretScrubber | undefined;
function auditScrubberOf(configured: SecretScrubber | undefined): SecretScrubber {
  return configured ?? (baseAuditScrubber ??= new SecretScrubber());
}

/**
 * Merge `patch` into the per-call audit accumulator: array-valued keys are **appended** (so
 * repeated `{ affected: [...] }` calls accumulate), other keys replace.
 */
function mergeAuditDetail(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key];
    if (Array.isArray(existing) && Array.isArray(value)) existing.push(...value);
    else target[key] = value;
  }
}

/** Compact, scrubbed summary of a tool result for the audit trail. */
function summarizeResult(
  result: CallToolResult,
  level: AuditToolIoLevel,
  scrubber: SecretScrubber,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive at the SDK result boundary; content may be absent at runtime.
  const content = result.content ?? [];
  const summary: Record<string, unknown> = {
    isError: result.isError === true,
    contentCount: content.length,
    contentTypes: [...new Set(content.map((c) => c.type))],
  };
  if (level === "full" && result.structuredContent !== undefined) {
    const scrubbed = scrubber.scrubObject(result.structuredContent);
    const serialized = JSON.stringify(scrubbed);
    summary.structuredContent =
      serialized.length > AUDIT_RESULT_MAX_CHARS ? { _truncated: true, bytes: serialized.length } : scrubbed;
  }
  return summary;
}

/**
 * Build the `tool.call` audit `detail`: the (scrubbed) request args + a result summary per the
 * `auditToolIo` level, plus the accumulated domain detail (affected resources, effects). Everything
 * is secret-scrubbed — resource ids/names stay readable, sensitive values are masked. Never throws:
 * a scrub/serialize failure degrades to the minimal record (fail-safe, never adds unscrubbed data).
 */
function buildAuditDetail(
  durationMs: number,
  args: Record<string, unknown>,
  result: CallToolResult | undefined,
  domainDetail: Record<string, unknown>,
  level: AuditToolIoLevel,
  resultScrubber: SecretScrubber | undefined,
): Record<string, unknown> {
  const detail: Record<string, unknown> = { durationMs };
  try {
    const scrubber = auditScrubberOf(resultScrubber);
    if (level !== "off") {
      detail.input = scrubber.scrubObject(args);
      if (result) detail.result = summarizeResult(result, level, scrubber);
    }
    // Domain detail (affected resources, effects) is always recorded, scrubbed.
    const domain = scrubber.scrubObject(domainDetail);
    if (domain && typeof domain === "object") Object.assign(detail, domain);
  } catch {
    detail.auditError = true;
  }
  return detail;
}

// ============================================================================
// Tool Registry Class
// ============================================================================

/**
 * Registry for MCP tools that implements ToolProvider.
 *
 * Extends BaseRegistry for standard CRUD operations (register, get, has, etc.)
 * and provides `bindToSdk()` for registering tools with MCP SDK server instances.
 *
 * @example
 * ```typescript
 * import { toolRegistry, defineTool } from 'mcp-server-framework';
 *
 * // Tools are auto-registered via defineTool()
 * defineTool({ name: 'greet', ... });
 *
 * // Registry can be used directly as a provider
 * builder.withToolProvider(toolRegistry);
 * ```
 */
export class ToolRegistry extends BaseRegistry<ToolDefinition> implements ToolProvider {
  // ──────────────────────────────────────────────────────────────────────────
  // Factory
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Creates an isolated ToolRegistry (no shared global state).
   *
   * Used for testing.
   */
  static createIsolated(): ToolRegistry {
    return new ToolRegistry();
  }
  // ──────────────────────────────────────────────────────────────────────────
  // BaseRegistry Override
  // ──────────────────────────────────────────────────────────────────────────

  protected override get itemTypeName(): string {
    return "Tool";
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Generic Registration (Variance-Safe)
  // ──────────────────────────────────────────────────────────────────────────
  /**
   * Register a tool from a generic factory function.
   *
   * Centralizes TypeScript generic variance handling. `ToolDefinition<TInput>`
   * is invariant — `TInput` appears in both covariant (input property) and
   * contravariant (handler parameter) positions via Zod's type mapping.
   * TypeScript requires `as unknown as` because neither `ToolDefinition<TInput>`
   * nor `ToolDefinition<ZodTypeAny>` sufficiently overlaps with the other.
   *
   * This is safe because the MCP SDK validates input via the Zod schema
   * at runtime before the handler is invoked.
   *
   * @internal Used by defineTool() — prefer registerOrReplace() for non-generic usage.
   */
  registerFromFactory<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
    tool: ToolDefinition<TInput, TOutput>,
  ): boolean {
    // @type-variance — Generic input/output erased for homogeneous storage; SDK validates at runtime
    return this.registerOrReplace(tool as unknown as ToolDefinition);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ToolProvider Implementation
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get all registered tools.
   *
   * @returns Readonly array of all tools
   */
  getTools(): ReadonlyArray<ToolDefinition> {
    return this.getAll();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SDK Binding
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Registers tool definitions with an MCP SDK server instance.
   *
   * Each tool is registered with:
   * - SDK-native cancellation via `extra.signal` (AbortSignal per request)
   * - Rate-limited progress reporting via `extra.sendNotification`
   * - Structured error handling with MCP error codes
   * - OpenTelemetry tracing spans and metrics recording
   * - Tool annotations passed through to the SDK
   *
   * @param sdk - The MCP SDK server instance
   * @param tools - Tool definitions to register
   * @param options - Registration context (logger, stateless mode)
   * @internal
   */
  static bindToSdk(sdk: McpServer, tools: readonly ToolDefinition[], options: ToolBindOptions): void {
    const { logger, logNotificationHandler, resultScrubber } = options;
    const auditToolIo: AuditToolIoLevel = options.auditToolIo ?? "summary";

    // Bridge framework logger → MCP notifications/message for this session.
    // When set, any logger.*() call during tool execution is also forwarded
    // to the connected MCP client as a notifications/message notification.
    // Log notifications reach the same client transcript as tool results —
    // scrub them with the same configured instance (falls back to the default
    // scrubber inside createContextLogger when result scrubbing is disabled).
    const sendMcpLog = logNotificationHandler
      ? mcpLogger.createContextLogger(logNotificationHandler, resultScrubber)
      : undefined;

    if (tools.length === 0) {
      logger.trace(SdkBindingMessages.NO_TOOLS);
      return;
    }

    logger.trace(SdkBindingMessages.TOOLS_REGISTERED, tools.length);

    const binding: ToolCallBinding = { ...options, sdk, auditToolIo, sendMcpLog };

    for (const tool of tools) {
      sdk.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          ...(tool.output && { outputSchema: tool.output }),
          ...(tool.annotations && { annotations: tool.annotations }),
          ...(tool._meta && { _meta: tool._meta }),
        },
        (args, extra) => ToolRegistry.handleToolCall(tool, args, extra, binding),
      );

      logger.trace(SdkBindingMessages.TOOL_REGISTERED, tool.name);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private SDK Binding Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** One `tools/call`: scope check, then the handler inside its tool and log context. */
  private static async handleToolCall(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    extra: SdkToolExtra,
    binding: ToolCallBinding,
  ): Promise<CallToolResult> {
    // SDK flows req.auth → extra.authInfo when bearer auth middleware is active
    const authInfo = extra.authInfo;

    // Tool-level scope enforcement (RBAC). Anonymous requests fall back to the
    // restricted anonymous scope set (if configured) so they are gated too;
    // `context.auth` stays derived from the real `authInfo` only.
    enforceScopeOrThrow(
      tool.requiredScopes,
      scopeSubject(authInfo, binding.anonymousScopes),
      "Tool",
      tool.name,
      binding.logger,
      extra,
    );

    // Per-call audit accumulator: domain detail (e.g. affected resources) the handler
    // attaches via context.recordAuditDetail, merged into the final tool.call event.
    const auditDetail: Record<string, unknown> = {};
    const context = ToolRegistry.buildToolContext(extra, binding, auditDetail);

    // Wrap tool execution so that:
    // 1. logger.*() calls are forwarded as MCP notifications/message (Logger Step 11)
    // 2. getCurrentToolContext() returns the context from anywhere in the call stack
    const executeInToolContext = () =>
      runWithToolContext(context, () => ToolRegistry.executeToolCall({ tool, args, context, auditDetail }, binding));

    const { sendMcpLog } = binding;
    if (!sendMcpLog) return executeInToolContext();

    // Identity label for the log prefix (username convention on auth.extra; else clientId).
    const userLabel = authUsername(authInfo?.extra) ?? authInfo?.clientId;
    return withExtendedContext(
      {
        sendMcpLog,
        requestId: String(extra.requestId),
        ...(extra.sessionId && { sessionId: extra.sessionId }),
        ...(userLabel && { user: userLabel }),
      },
      executeInToolContext,
    );
  }

  /** Builds the context a tool handler receives. */
  private static buildToolContext(
    extra: SdkToolExtra,
    binding: ToolCallBinding,
    auditDetail: Record<string, unknown>,
  ): ToolContext {
    const { signal: abortSignal, requestId, sessionId, authInfo } = extra;
    const progressToken = extra._meta?.progressToken;

    return {
      reportProgress: createProgressReporter(extra.sendNotification.bind(extra), progressToken),
      abortSignal,
      requestId,
      sessionId,
      stateless: binding.stateless,
      sendNotification: extra.sendNotification.bind(extra),
      recordAuditDetail: (detail) => {
        mergeAuditDetail(auditDetail, detail);
      },
      // authInfo.extra is populated by the onAuthenticated hook in auth-middleware.ts.
      ...(authInfo && { auth: { authInfo, extra: authInfo.extra } }),
      ...ToolRegistry.buildClientRequests(extra, binding),
    };
  }

  /** The client requests a handler can make: only in stateful mode and with the client's capability. */
  private static buildClientRequests(
    extra: SdkToolExtra,
    { sdk, stateless, jsonResponse }: ToolCallBinding,
  ): Pick<ToolContext, "createMessage" | "listRoots" | "elicitInput"> {
    if (stateless) return {};
    const clientCaps = sdk.server.getClientCapabilities();

    // Send on this call's own stream: without `relatedRequestId` the SDK uses the standalone
    // GET stream, and a client that has none open never sees the request. In JSON response
    // mode the call has no stream and the SDK would drop it, so the GET stream is all there
    // is. The signal ties the request to the call, so cancelling one cancels the other.
    const clientRequestOptions: RequestOptions = {
      signal: extra.signal,
      ...(!jsonResponse && { relatedRequestId: extra.requestId }),
    };

    return {
      ...(clientCaps?.sampling && {
        createMessage: (params: Parameters<NonNullable<ToolContext["createMessage"]>>[0]) =>
          sdk.server.createMessage(params, clientRequestOptions),
      }),
      ...(clientCaps?.roots && { listRoots: () => sdk.server.listRoots(undefined, clientRequestOptions) }),
      ...(clientCaps?.elicitation && {
        elicitInput: (
          params: Parameters<NonNullable<ToolContext["elicitInput"]>>[0],
          requestOptions?: RequestOptions,
        ) => sdk.server.elicitInput(params, { ...clientRequestOptions, ...requestOptions }),
      }),
    };
  }

  /**
   * Executes a tool handler with cancellation, progress, tracing, and error handling.
   */
  private static executeToolCall(call: ToolCall, binding: ToolCallBinding): Promise<CallToolResult> {
    const { tool, args, context } = call;
    const { logger, resultScrubber } = binding;
    const startTime = Date.now();
    let success = true;
    let handlerResult: CallToolResult | undefined;

    return withSpan(
      `mcp.tool.${tool.name}`,
      async (span) => {
        span.setAttributes({
          [MCP_ATTRIBUTES.TOOL_NAME]: tool.name,
          [MCP_ATTRIBUTES.OPERATION]: "tool_call",
          [MCP_ATTRIBUTES.REQUEST_ID]: String(context.requestId),
          ...(context.sessionId && {
            [MCP_ATTRIBUTES.SESSION_ID]: context.sessionId,
          }),
        });

        try {
          // Check for pre-cancellation
          if (context.abortSignal.aborted) {
            // @sdk-constraint — SDK ErrorCode has no cancellation code; use framework's REQUEST_CANCELLED (-32002)
            throw new McpError(JsonRpcErrorCode.REQUEST_CANCELLED, SdkBindingMessages.REQUEST_CANCELLED_BEFORE);
          }

          logger.debug(SdkBindingMessages.TOOL_EXECUTING, tool.name);

          // @sdk-constraint — SDK registerTool erases input schema type; args validated at runtime by SDK
          const result = await tool.handler(args as Parameters<typeof tool.handler>[0], context);
          handlerResult = result; // captured (raw) for the audit trail; the audit scrubs independently

          // Record result metadata on span
          span.setAttributes({
            [MCP_ATTRIBUTES.SUCCESS]: true,
            [MCP_ATTRIBUTES.RESULT_IS_ERROR]: result.isError === true,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive at the SDK result boundary; content may be absent at runtime.
            [MCP_ATTRIBUTES.RESULT_CONTENT_COUNT]: result.content?.length ?? 0,
          });

          // Central secret-redaction boundary: the only place every tool result
          // passes before it reaches the SDK (→ client transcript → model provider).
          return resultScrubber && tool.scrubResult !== false
            ? scrubCallToolResult(result, resultScrubber, logger, tool.name)
            : result;
        } catch (error) {
          success = false;
          span.setAttribute(MCP_ATTRIBUTES.SUCCESS, false);
          throw ToolRegistry.toCallError(error, call, binding);
        } finally {
          const durationMs = Date.now() - startTime;
          getServerMetrics().recordRequest(tool.name, durationMs, success);
          if (success) {
            logger.debug(SdkBindingMessages.TOOL_COMPLETED, tool.name, durationMs);
          }
          ToolRegistry.auditToolCall(call, success, durationMs, handlerResult, binding);
        }
      },
      { kind: SpanKind.SERVER },
    );
  }

  /** Logs a failed tool call and returns the error the SDK should answer with. */
  private static toCallError(error: unknown, { tool, context }: ToolCall, binding: ToolCallBinding): unknown {
    const { logger, resultScrubber } = binding;

    // Handle cancellation
    if (context.abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
      logger.info(SdkBindingMessages.TOOL_CANCELLED, tool.name);
      // @sdk-constraint — SDK ErrorCode has no cancellation code; use framework's REQUEST_CANCELLED (-32002)
      return new McpError(JsonRpcErrorCode.REQUEST_CANCELLED, SdkBindingMessages.REQUEST_CANCELLED);
    }

    if (error instanceof AppError && error.statusCode < 500) {
      logger.warn(SdkBindingMessages.TOOL_ERROR, tool.name, error.message);
    } else {
      logger.error(SdkBindingMessages.TOOL_ERROR, tool.name, error);
    }

    if (error instanceof McpError) {
      return scrubThrownError(error, resultScrubber);
    }
    // Thrown protocol errors bypass the result-scrub boundary — scrub the
    // wrapped message too, since upstream errors can embed API responses.
    const wrapped = `Error executing ${tool.name}: ${error instanceof Error ? error.message : String(error)}`;
    return new McpError(ErrorCode.InternalError, resultScrubber ? resultScrubber.scrub(wrapped) : wrapped);
  }

  /**
   * Audit trail: every tool invocation as one correlatable request→response record
   * (actor ↔ session ↔ request ↔ tool ↔ what was requested/affected/returned).
   */
  private static auditToolCall(
    { tool, args, context, auditDetail }: ToolCall,
    success: boolean,
    durationMs: number,
    result: CallToolResult | undefined,
    { auditToolIo, resultScrubber }: ToolCallBinding,
  ): void {
    const username = authUsername(context.auth?.extra);
    logAuditEvent({
      category: "tool",
      action: "tool.call",
      outcome: success ? "success" : "failure",
      requestId: String(context.requestId),
      target: tool.name,
      actor: {
        ...(context.sessionId && { sessionId: context.sessionId }),
        ...(context.auth?.authInfo.clientId && { userId: context.auth.authInfo.clientId }),
        ...(username && { username }),
      },
      detail: buildAuditDetail(durationMs, args, result, auditDetail, auditToolIo, resultScrubber),
    });
  }
}

// ============================================================================
// Global Singleton Instance
// ============================================================================

/**
 * Global tool registry singleton.
 *
 * This instance is used by defineTool() for auto-registration
 * and by createServer() to discover all tools.
 */
export const globalToolRegistry = new ToolRegistry();
