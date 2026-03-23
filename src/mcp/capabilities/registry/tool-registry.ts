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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { z } from "zod";

import type { ToolDefinition, ToolContext, ToolProvider } from "../../types/index.js";
import { createProgressReporter } from "../../handlers/index.js";
import type { Logger } from "../../../logger/index.js";
import { JsonRpcErrorCode, AppError } from "../../../errors/index.js";
import { withSpan, getServerMetrics, MCP_ATTRIBUTES, SpanKind } from "../../../telemetry/index.js";
import { BaseRegistry } from "./base-registry.js";
import { enforceScopeOrThrow } from "./scope-enforcement.js";

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
 * Options for binding tools to an MCP SDK server.
 * @internal
 */
export interface ToolBindOptions {
  readonly logger: Logger;
  readonly stateless: boolean;
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
  registerFromFactory<TInput extends z.ZodTypeAny>(tool: ToolDefinition<TInput>): boolean {
    // @type-variance — Generic input erased for homogeneous storage; SDK validates at runtime
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
    const { logger, stateless } = options;

    if (tools.length === 0) {
      logger.trace(SdkBindingMessages.NO_TOOLS);
      return;
    }

    logger.trace(SdkBindingMessages.TOOLS_REGISTERED, tools.length);

    for (const tool of tools) {
      sdk.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          ...(tool.annotations && { annotations: tool.annotations }),
          ...(tool._meta && { _meta: tool._meta }),
        },
        async (args, extra) => {
          const { signal: abortSignal, requestId, sessionId } = extra;
          const progressToken = extra._meta?.progressToken;
          const reportProgress = createProgressReporter(extra.sendNotification.bind(extra), progressToken);

          // ── Auth Context from SDK ────────────────────────────────────────
          // SDK flows req.auth → extra.authInfo when bearer auth middleware is active
          const authInfo = extra.authInfo;

          // Tool-level scope enforcement (RBAC)
          enforceScopeOrThrow(tool.requiredScopes, authInfo, "Tool", tool.name, logger);

          // Build auth context for tool handler
          const auth = authInfo
            ? {
                authInfo,
                extra: undefined as Record<string, unknown> | undefined,
              }
            : undefined;

          // Cross-request features: only available in stateful mode + client capability
          const isStateful = !stateless;
          const clientCaps = sdk.server.getClientCapabilities();

          const createMessage =
            isStateful && clientCaps?.sampling ? sdk.server.createMessage.bind(sdk.server) : undefined;

          const listRoots = isStateful && clientCaps?.roots ? sdk.server.listRoots.bind(sdk.server) : undefined;

          const elicitInput =
            isStateful && clientCaps?.elicitation ? sdk.server.elicitInput.bind(sdk.server) : undefined;

          return ToolRegistry.executeToolCall(
            tool,
            args,
            {
              reportProgress,
              abortSignal,
              requestId,
              sessionId,
              stateless,
              ...(auth && { auth }),
              ...(createMessage && { createMessage }),
              ...(listRoots && { listRoots }),
              ...(elicitInput && { elicitInput }),
            },
            logger,
          );
        },
      );

      logger.trace(SdkBindingMessages.TOOL_REGISTERED, tool.name);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private SDK Binding Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Executes a tool handler with cancellation, progress, tracing, and error handling.
   */
  private static executeToolCall(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolContext,
    logger: Logger,
  ): Promise<CallToolResult> {
    const startTime = Date.now();
    let success = true;

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

          logger.info(SdkBindingMessages.TOOL_EXECUTING, tool.name);

          // @sdk-constraint — SDK registerTool erases input schema type; args validated at runtime by SDK
          const result = await tool.handler(args as Parameters<typeof tool.handler>[0], context);

          // Record result metadata on span
          span.setAttributes({
            [MCP_ATTRIBUTES.SUCCESS]: true,
            [MCP_ATTRIBUTES.RESULT_IS_ERROR]: result.isError === true,
            [MCP_ATTRIBUTES.RESULT_CONTENT_COUNT]: result.content?.length ?? 0,
          });

          return result;
        } catch (error) {
          success = false;

          // Handle cancellation
          if (context.abortSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
            logger.info(SdkBindingMessages.TOOL_CANCELLED, tool.name);
            span.setAttribute(MCP_ATTRIBUTES.SUCCESS, false);
            // @sdk-constraint — SDK ErrorCode has no cancellation code; use framework's REQUEST_CANCELLED (-32002)
            throw new McpError(JsonRpcErrorCode.REQUEST_CANCELLED, SdkBindingMessages.REQUEST_CANCELLED);
          }

          if (error instanceof AppError && error.statusCode < 500) {
            logger.warn(SdkBindingMessages.TOOL_ERROR, tool.name, error.message);
          } else {
            logger.error(SdkBindingMessages.TOOL_ERROR, tool.name, error);
          }
          span.setAttribute(MCP_ATTRIBUTES.SUCCESS, false);

          if (error instanceof McpError) {
            throw error;
          }
          throw new McpError(
            ErrorCode.InternalError,
            `Error executing ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          const durationMs = Date.now() - startTime;
          getServerMetrics().recordRequest(tool.name, durationMs, success);
          if (success) {
            logger.debug(SdkBindingMessages.TOOL_COMPLETED, tool.name, durationMs);
          }
        }
      },
      { kind: SpanKind.SERVER },
    );
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
