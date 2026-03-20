/**
 * MCP Definition Types
 *
 * Unified type definitions for MCP tools, resources, and prompts.
 * These are the canonical types used throughout the framework.
 *
 * DESIGN PRINCIPLES:
 * - User-friendly naming (no I-prefix, 'input' instead of 'schema')
 * - Single source of truth for each concept
 * - Compatible with MCP SDK types
 *
 * @module mcp/types/definition
 */

import type { CallToolResult, GetTaskResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { ToolContext, TaskCreateContext, TaskOperationContext } from "./context.js";
import type { CreateTaskResult } from "@modelcontextprotocol/sdk/experimental/tasks/types.js";

// ============================================================================
// Completion Types
// ============================================================================

/**
 * Result of an autocompletion callback.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/completion
 */
export interface CompletionResult {
  /** Suggested completion values */
  readonly values: string[];
  /** Total number of available completions (for pagination hints) */
  readonly total?: number;
  /** Whether more completions are available beyond the returned values */
  readonly hasMore?: boolean;
}

/**
 * Callback for providing autocompletion suggestions.
 *
 * Used on resource templates (for URI template variables) and prompts
 * (for prompt arguments). The callback is invoked when a client sends
 * a `completion/complete` request.
 *
 * @param argName - Name of the argument/variable being completed
 * @param argValue - Current partial value typed by the user
 * @returns Completion suggestions
 */
export type CompletionCallback = (argName: string, argValue: string) => CompletionResult | Promise<CompletionResult>;

// ============================================================================
// Tool Types
// ============================================================================

/**
 * Tool annotations providing behavioral hints per MCP specification.
 *
 * These help clients understand tool characteristics without parsing descriptions.
 * All properties are optional and represent hints — not guarantees.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations
 */
export interface ToolAnnotations {
  /** Human-readable title for display purposes */
  readonly title?: string;

  /** If true, the tool does not modify any external state (default assumption: false) */
  readonly readOnlyHint?: boolean;

  /** If true, the tool may perform destructive operations (default assumption: true) */
  readonly destructiveHint?: boolean;

  /** If true, calling the tool repeatedly with the same args has no additional effect */
  readonly idempotentHint?: boolean;

  /** If true, the tool interacts with external entities beyond its own system */
  readonly openWorldHint?: boolean;
}

/**
 * Tool definition - the canonical type for MCP tools.
 *
 * This is the ONLY type needed for defining and registering tools.
 * Used by `defineTool()`, `ToolRegistry`, and `McpServerBuilder`.
 *
 * @typeParam TInput - Zod schema type for input validation (default: any Zod type)
 *
 * @example
 * ```typescript
 * const greetTool = defineTool({
 *   name: 'greet',
 *   description: 'Greet a user by name',
 *   input: z.object({ name: z.string() }),
 *   handler: async ({ name }, ctx) => text(`Hello, ${name}!`),
 * });
 * ```
 */
export interface ToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique tool name (e.g., 'greet', 'list_servers') */
  readonly name: string;

  /** Human-readable description shown to LLM */
  readonly description: string;

  /** Zod schema for input validation */
  readonly input: TInput;

  /**
   * Optional annotations providing hints about tool behavior.
   *
   * Per MCP specification, annotations help clients understand tool characteristics
   * without needing to parse the description. These are hints, not guarantees.
   *
   * @see https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations
   */
  readonly annotations?: ToolAnnotations;

  /**
   * Optional metadata passed through to the MCP SDK tool registration.
   *
   * This is a generic passthrough for protocol-level metadata like
   * `{ ui: { resourceUri: 'app://my-app' } }` used by MCP Apps.
   * The framework does not interpret `_meta` — it is forwarded as-is.
   */
  readonly _meta?: Record<string, unknown>;

  /**
   * Scopes required to execute this tool (RBAC).
   *
   * When set, the framework checks `authInfo.scopes` BEFORE
   * the handler executes. All listed scopes must be present (AND logic).
   * If the check fails, a 403 Forbidden error is returned.
   *
   * Omit or set to `undefined` for tools accessible to any authenticated user.
   */
  readonly requiredScopes?: readonly string[];

  /**
   * Tool handler function.
   *
   * @param args - Validated input (typed from Zod schema)
   * @param context - Execution context with progress reporter, abort signal
   * @returns MCP CallToolResult (use response helpers: text(), json(), error())
   */
  handler: (args: z.infer<TInput>, context: ToolContext) => Promise<CallToolResult>;
}

/**
 * Tool provider interface for registries and plugins.
 *
 * Provides access to all registered tools.
 */
export interface ToolProvider {
  /** Get all registered tools */
  getTools(): ReadonlyArray<ToolDefinition>;
}

// ============================================================================
// Resource Types
// ============================================================================

/**
 * Base resource definition - shared properties for all resources.
 *
 * This is the common base for both static resources and resource templates.
 * Provides consistent naming, description, and MIME type handling.
 */
export interface BaseResourceDefinition {
  /** Unique resource name for identification */
  readonly name: string;

  /** Human-readable description shown to LLM */
  readonly description: string;

  /** MIME type of the content (optional) */
  readonly mimeType?: string;
}

/**
 * Static resource definition - for fixed URI resources.
 *
 * Use this for resources with a fixed URI that don't require parameters.
 * For dynamic URIs with parameters, use `ResourceTemplateDefinition`.
 *
 * @example
 * ```typescript
 * const configResource = defineResource({
 *   name: 'app-config',
 *   description: 'Application configuration',
 *   uri: 'myapp://config/main',
 *   mimeType: 'application/json',
 *   read: async () => JSON.stringify({ version: '1.0.0' }),
 * });
 * ```
 */
export interface ResourceStaticDefinition extends BaseResourceDefinition {
  /** Resource URI (e.g., 'myapp://config/main') */
  readonly uri: string;

  /**
   * Scopes required to read this resource (RBAC).
   *
   * When set, the framework checks `authInfo.scopes` BEFORE
   * the read handler executes. All listed scopes must be present (AND logic).
   * If the check fails, a 403 Forbidden error is returned.
   *
   * Omit or set to `undefined` for resources accessible to any authenticated user.
   */
  readonly requiredScopes?: readonly string[];

  /**
   * Content provider function.
   *
   * @returns String content or Uint8Array for binary data
   */
  read: () => Promise<string | Uint8Array>;
}

/**
 * Resource template definition - for dynamic URIs (RFC 6570).
 *
 * Templates allow LLMs to access content with variable parameters.
 * Use Zod schemas for type-safe parameter handling.
 *
 * @typeParam TInput - Zod object schema for parameter validation (default: z.AnyZodObject)
 *
 * @example
 * ```typescript
 * // With typed parameters
 * const logResource = defineResourceTemplate({
 *   name: 'log-viewer',
 *   description: 'View logs by ID',
 *   uriTemplate: 'myapp://logs/{logId}',
 *   mimeType: 'text/plain',
 *   input: z.object({
 *     logId: z.string().describe('Log identifier'),
 *   }),
 *   read: async ({ logId }) => fetchLog(logId),
 *   list: async () => [
 *     { uri: 'myapp://logs/1', name: 'Log 1' },
 *   ],
 * });
 *
 * // Without schema (params are Record<string, string>)
 * const simpleResource = defineResourceTemplate({
 *   name: 'simple',
 *   description: 'Simple item lookup',
 *   uriTemplate: 'myapp://item/{id}',
 *   read: async (params) => getItem(params.id),
 * });
 * ```
 */
export interface ResourceTemplateDefinition<
  TInput extends z.AnyZodObject = z.AnyZodObject,
> extends BaseResourceDefinition {
  /** URI template pattern using RFC 6570 (e.g., 'myapp://logs/{logId}') */
  readonly uriTemplate: string;

  /**
   * Zod object schema for parameter validation.
   *
   * When provided, parameters extracted from the URI are validated
   * against this schema before being passed to `read()`.
   *
   * @example
   * ```typescript
   * input: z.object({
   *   logId: z.string().describe('Log identifier'),
   *   format: z.enum(['json', 'text']).optional(),
   * })
   * ```
   */
  readonly input?: TInput;

  /**
   * Content provider function with template parameters.
   *
   * @param params - Parameters extracted from URI template (typed if input schema provided)
   * @returns String content or Uint8Array for binary data
   */
  read: (params: z.infer<TInput>) => Promise<string | Uint8Array>;

  /**
   * Optional function to enumerate available resources.
   *
   * When provided, this enables LLMs to discover what resources are available
   * for this template. Useful for dynamic resource discovery.
   */
  list?: () => Promise<
    Array<{
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
    }>
  >;

  /**
   * Optional callback for argument autocompletion.
   *
   * When provided, enables clients to request autocompletion suggestions
   * for URI template variables. The callback receives the variable name
   * and current partial value, and returns matching suggestions.
   *
   * The SDK automatically registers the `completions` capability when
   * any resource template provides a `complete` callback.
   *
   * @param argName - The URI template variable name being completed
   * @param argValue - The current partial value typed by the user
   * @returns Completion suggestions
   *
   * @example
   * ```typescript
   * defineResourceTemplate({
   *   name: 'note',
   *   uriTemplate: 'notes://note/{noteId}',
   *   read: async ({ noteId }) => fetchNote(noteId),
   *   complete: async (argName, argValue) => ({
   *     values: allNoteIds.filter(id => id.startsWith(argValue)),
   *   }),
   * });
   * ```
   */
  complete?: CompletionCallback;

  /**
   * Scopes required to read this resource template (RBAC).
   *
   * When set, the framework checks `authInfo.scopes` BEFORE
   * the read handler executes. All listed scopes must be present (AND logic).
   * If the check fails, a 403 Forbidden error is returned.
   *
   * Omit or set to `undefined` for resources accessible to any authenticated user.
   */
  readonly requiredScopes?: readonly string[];
}

/**
 * Union type for any resource definition.
 *
 * Use this when accepting either static resources or templates.
 * Use type guards `isStaticResource()` / `isResourceTemplate()` to narrow.
 *
 * @example
 * ```typescript
 * function processResource(resource: ResourceDefinition) {
 *   if (isStaticResource(resource)) {
 *     // TypeScript knows: resource.uri, resource.read()
 *   } else {
 *     // TypeScript knows: resource.uriTemplate, resource.read(params)
 *   }
 * }
 * ```
 */
export type ResourceDefinition<TInput extends z.AnyZodObject = z.AnyZodObject> =
  | ResourceStaticDefinition
  | ResourceTemplateDefinition<TInput>;

// ─────────────────────────────────────────────────────────────────────────────
// Resource Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type guard for static resources.
 */
export function isStaticResource(resource: ResourceDefinition): resource is ResourceStaticDefinition {
  return "uri" in resource && !("uriTemplate" in resource);
}

/**
 * Type guard for resource templates.
 */
export function isResourceTemplate<TInput extends z.AnyZodObject = z.AnyZodObject>(
  resource: ResourceDefinition<TInput>,
): resource is ResourceTemplateDefinition<TInput> {
  return "uriTemplate" in resource;
}

/**
 * Resource content types for MCP protocol response.
 */
export interface TextResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
}

export interface BlobResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  /** Base64 encoded binary content */
  readonly blob: string;
}

export type ResourceContent = TextResourceContent | BlobResourceContent;

/**
 * Resource provider interface for registries and plugins.
 *
 * Provides access to static resources and resource templates
 * for MCP `resources/list` and `resources/read` requests.
 *
 * This combined provider handles both resource types for convenience.
 * Use `isStaticResource()` / `isResourceTemplate()` type guards when needed.
 */
export interface ResourceProvider {
  /** Get all static resources */
  getResources(): ReadonlyArray<ResourceStaticDefinition>;
  /** Get all resource templates */
  getTemplates(): ReadonlyArray<ResourceTemplateDefinition>;
  /** Check if provider has any resources (static or templates) */
  hasResources(): boolean;
}

// ============================================================================
// Prompt Types
// ============================================================================

/**
 * Prompt message role.
 */
export type PromptRole = "user" | "assistant";

/**
 * Prompt message in generated prompt output.
 */
export interface PromptMessage {
  /** Message role */
  readonly role: PromptRole;
  /** Message content */
  readonly content: string;
}

/**
 * Prompt definition - the canonical type for MCP prompts.
 *
 * Prompts generate pre-defined message sequences that guide LLM behavior.
 * Use Zod schemas for type-safe argument handling.
 *
 * @typeParam TInput - Zod object schema for input validation (default: z.ZodObject<{}>)
 *
 * @example
 * ```typescript
 * // With typed arguments
 * const explainPrompt = definePrompt({
 *   name: 'explain-concept',
 *   description: 'Explain a technical concept',
 *   input: z.object({
 *     topic: z.string().describe('Topic to explain'),
 *     level: z.enum(['beginner', 'expert']).default('beginner'),
 *   }),
 *   generate: async ({ topic, level }) => [
 *     { role: 'user', content: `Explain ${topic} at ${level} level.` },
 *   ],
 * });
 *
 * // Without arguments
 * const greetingPrompt = definePrompt({
 *   name: 'greeting',
 *   description: 'Standard greeting',
 *   generate: async () => [
 *     { role: 'user', content: 'Hello!' },
 *   ],
 * });
 * ```
 */
export interface PromptDefinition<TInput extends z.AnyZodObject = z.AnyZodObject> {
  /** Unique prompt name */
  readonly name: string;

  /** Human-readable description shown to LLM */
  readonly description: string;

  /**
   * Zod object schema for argument validation.
   *
   * The SDK automatically extracts argument names, descriptions, and
   * required status from the Zod schema. Use `.describe()` on fields
   * to provide human-readable descriptions.
   *
   * @example
   * ```typescript
   * input: z.object({
   *   topic: z.string().describe('The topic to explain'),
   *   depth: z.enum(['brief', 'detailed']).optional().describe('Level of detail'),
   * })
   * ```
   */
  readonly input?: TInput;

  /**
   * Generate prompt messages.
   *
   * @param args - Validated arguments (typed from Zod schema)
   * @returns Array of messages
   */
  generate: (args: z.infer<TInput>) => Promise<ReadonlyArray<PromptMessage>>;

  /**
   * Optional callback for argument autocompletion.
   *
   * When provided, enables clients to request autocompletion suggestions
   * for prompt arguments. The callback receives the argument name
   * and current partial value, and returns matching suggestions.
   *
   * Requires `input` schema to be defined — prompt arguments are derived
   * from the Zod schema fields. The SDK wraps each schema field with
   * `completable()` internally.
   *
   * @param argName - The prompt argument name being completed
   * @param argValue - The current partial value typed by the user
   * @returns Completion suggestions
   *
   * @example
   * ```typescript
   * definePrompt({
   *   name: 'summarize',
   *   input: z.object({ style: z.string() }),
   *   generate: async ({ style }) => [{ role: 'user', content: `Summarize in ${style}` }],
   *   complete: async (argName, argValue) => ({
   *     values: ['bullet-points', 'paragraph', 'tldr'].filter(s => s.startsWith(argValue)),
   *   }),
   * });
   * ```
   */
  complete?: CompletionCallback;

  /**
   * Scopes required to get this prompt (RBAC).
   *
   * When set, the framework checks `authInfo.scopes` BEFORE
   * the generate handler executes. All listed scopes must be present (AND logic).
   * If the check fails, a 403 Forbidden error is returned.
   *
   * Omit or set to `undefined` for prompts accessible to any authenticated user.
   */
  readonly requiredScopes?: readonly string[];
}

/**
 * Prompt provider interface for registries and plugins.
 *
 * Provides access to prompts for MCP `prompts/list`
 * and `prompts/get` requests.
 */
export interface PromptProvider {
  /** Get all prompts */
  getPrompts(): ReadonlyArray<PromptDefinition>;
  /** Check if provider has any prompts */
  hasPrompts(): boolean;
}

// ============================================================================
// App Definition (MCP Apps — Tool + Resource)
// ============================================================================

/**
 * Resource definition embedded within an {@link AppDefinition}.
 *
 * Declares the UI resource that backs the MCP App. The resource is
 * registered automatically when `defineApp()` is called.
 */
export interface AppResourceDefinition {
  /** Static resource URI — must use `ui://` scheme (e.g., 'ui://calculator') */
  readonly uri: string;

  /** Optional resource name (defaults to app name) */
  readonly name?: string;

  /** Optional resource description (defaults to app description) */
  readonly description?: string;

  /** MIME type of the resource content (default: 'text/html;profile=mcp-app') */
  readonly mimeType?: string;

  /**
   * Read the resource content.
   *
   * @returns Resource content as string (text) or Uint8Array (binary)
   */
  read: () => string | Uint8Array | Promise<string | Uint8Array>;
}

/**
 * Definition for an MCP App — a tool linked to a UI resource.
 *
 * MCP Apps combine a tool with a resource to create interactive
 * experiences. The tool's `_meta.ui.resourceUri` links to the
 * resource, and MCP clients use this to render the UI.
 *
 * `defineApp()` internally creates both a `defineTool()` and a
 * `defineResource()`, auto-registering them in the global registries.
 *
 * @example
 * ```typescript
 * import { defineApp, text, z } from 'mcp-server-framework';
 *
 * const calculator = defineApp({
 *   name: 'calculator',
 *   description: 'An interactive calculator app',
 *   resource: {
 *     uri: 'ui://calculator',
 *     mimeType: 'text/html',
 *     read: async () => '<html>...calculator UI...</html>',
 *   },
 *   input: z.object({ expression: z.string() }),
 *   handler: async ({ expression }) => text(String(eval(expression))),
 * });
 * ```
 */
export interface AppDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique app/tool name */
  readonly name: string;

  /** Human-readable description */
  readonly description: string;

  /** Resource definition for the app's UI */
  readonly resource: AppResourceDefinition;

  /** Zod schema for tool input validation */
  readonly input: TInput;

  /**
   * Tool handler function.
   *
   * @param args - Validated input (typed from Zod schema)
   * @param context - Execution context with progress reporter, abort signal
   * @returns MCP CallToolResult (use response helpers: text(), json(), error())
   */
  handler: (args: z.infer<TInput>, context: ToolContext) => Promise<CallToolResult>;

  /** Optional tool annotations */
  readonly annotations?: ToolAnnotations;

  /**
   * Additional `_meta` merged with the auto-generated `ui.resourceUri`.
   * The `ui.resourceUri` key is always set automatically from the resource URI.
   */
  readonly _meta?: Record<string, unknown>;

  /**
   * Scopes required to execute this app's tool (RBAC).
   *
   * Passed through to the internal `defineTool()` call.
   * All listed scopes must be present (AND logic).
   */
  readonly requiredScopes?: readonly string[];
}

// ============================================================================
// Task Tool Types (Experimental — Async Tool Execution)
// ============================================================================

/**
 * Task support level for a task-enabled tool.
 *
 * - `'optional'` — Tool can be called normally or as a task
 * - `'required'` — Tool MUST be called as a task (async execution only)
 *
 * Note: `'forbidden'` is not valid for task tools — use a regular
 * `defineTool()` for tools that never support task execution.
 *
 * @experimental MCP Tasks is an experimental SDK feature
 */
export type TaskSupport = "optional" | "required";

/**
 * Handler interface for task-based tool execution.
 *
 * Task tools use a three-method handler instead of a single callback,
 * enabling long-running operations with a create → poll → result lifecycle:
 *
 * 1. **`createTask`** — Initiate the task, return immediately with a task ID
 * 2. **`getTask`** — Return current task status (clients poll this)
 * 3. **`getTaskResult`** — Return the final result when the task completes
 *
 * @typeParam TInput - Zod schema type for input validation (inferred)
 *
 * @experimental MCP Tasks is an experimental SDK feature
 *
 * @example
 * ```typescript
 * const handler: TaskToolHandler<typeof inputSchema> = {
 *   createTask: async (args, ctx) => {
 *     const task = await ctx.taskStore.createTask({});
 *     startBackgroundWork(task.taskId, args);
 *     return { task };
 *   },
 *   getTask: async (_args, ctx) => {
 *     return ctx.taskStore.getTask(ctx.taskId);
 *   },
 *   getTaskResult: async (_args, ctx) => {
 *     return ctx.taskStore.getTaskResult(ctx.taskId);
 *   },
 * };
 * ```
 */
export interface TaskToolHandler<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  /**
   * Create and start a new task.
   *
   * Called when the client issues a `tools/call` with task parameters.
   * Should initiate the background work and return immediately.
   *
   * @param args - Validated input (typed from Zod schema)
   * @param context - Task creation context with `taskStore`
   * @returns Object containing the created task
   */
  createTask: (args: z.infer<TInput>, context: TaskCreateContext) => Promise<CreateTaskResult>;

  /**
   * Get the current status of a task.
   *
   * Called when the client polls via `tasks/get`.
   * Return the task with its current status.
   *
   * @param args - Original tool input args
   * @param context - Task operation context with `taskId` and `taskStore`
   * @returns Task status result
   */
  getTask: (args: z.infer<TInput>, context: TaskOperationContext) => Promise<GetTaskResult>;

  /**
   * Get the final result of a completed task.
   *
   * Called when the client requests the result via `tasks/result`.
   * Should return the tool's final output.
   *
   * @param args - Original tool input args
   * @param context - Task operation context with `taskId` and `taskStore`
   * @returns MCP CallToolResult (use response helpers: text(), json(), error())
   */
  getTaskResult: (args: z.infer<TInput>, context: TaskOperationContext) => Promise<CallToolResult>;
}

/**
 * Task tool definition — a tool with asynchronous task execution support.
 *
 * Task tools enable long-running operations that report progress asynchronously.
 * Instead of blocking the tool call until completion, the client receives a task ID
 * and can poll for status updates and results.
 *
 * Registered via `defineTask()` which auto-registers in `globalTaskToolRegistry`.
 * The framework uses the SDK's `experimental.tasks.registerToolTask()` internally.
 *
 * @typeParam TInput - Zod schema type for input validation (default: any Zod type)
 *
 * @experimental MCP Tasks is an experimental SDK feature
 *
 * @example
 * ```typescript
 * import { defineTask, text, z } from 'mcp-server-framework';
 *
 * export const longRunningTool = defineTask({
 *   name: 'long_computation',
 *   description: 'Perform a long computation',
 *   input: z.object({ data: z.string() }),
 *   taskSupport: 'required',
 *   taskHandler: {
 *     createTask: async (args, ctx) => {
 *       const task = await ctx.taskStore.createTask({ ttl: 300_000 });
 *       startBackgroundWork(task.taskId, args);
 *       return { task };
 *     },
 *     getTask: async (_args, ctx) => ctx.taskStore.getTask(ctx.taskId),
 *     getTaskResult: async (_args, ctx) => ctx.taskStore.getTaskResult(ctx.taskId),
 *   },
 * });
 * ```
 */
export interface TaskToolDefinition<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique tool name (e.g., 'long_computation') */
  readonly name: string;

  /** Human-readable description shown to LLM */
  readonly description: string;

  /** Zod schema for input validation */
  readonly input: TInput;

  /**
   * Task support level.
   *
   * - `'optional'` — Tool can be called normally or as a task
   * - `'required'` — Tool MUST be called as a task
   *
   * @default 'required'
   */
  readonly taskSupport?: TaskSupport;

  /**
   * Task handler with create/get/getResult methods.
   *
   * These three methods implement the task lifecycle:
   * 1. `createTask` — Start the background work
   * 2. `getTask` — Report current status
   * 3. `getTaskResult` — Return the final result
   */
  readonly taskHandler: TaskToolHandler<TInput>;

  /**
   * Optional annotations providing hints about tool behavior.
   *
   * @see ToolAnnotations
   */
  readonly annotations?: ToolAnnotations;

  /**
   * Optional metadata passed through to the MCP SDK.
   */
  readonly _meta?: Record<string, unknown>;

  /**
   * Scopes required to execute this task tool (RBAC).
   *
   * When set, the framework checks `authInfo.scopes` BEFORE
   * the task handler executes. All listed scopes must be present (AND logic).
   * If the check fails, a 403 Forbidden error is returned.
   *
   * Omit or set to `undefined` for task tools accessible to any authenticated user.
   */
  readonly requiredScopes?: readonly string[];
}

/**
 * Task tool provider interface for registries and plugins.
 *
 * Provides access to all registered task tools.
 *
 * @experimental MCP Tasks is an experimental SDK feature
 */
export interface TaskToolProvider {
  /** Get all registered task tools */
  getTaskTools(): ReadonlyArray<TaskToolDefinition>;
}
