/**
 * Prompt Registry
 *
 * Global registry for MCP prompts that implements PromptProvider.
 * Extends BaseRegistry for common CRUD operations.
 *
 * The registry is the single authority for prompt definitions:
 * - Storage: CRUD operations via BaseRegistry
 * - SDK Binding: `bindToSdk()` registers prompts with MCP SDK server instances
 *
 * @module mcp/capabilities/registry/prompt-registry
 */

import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import type { z } from "zod";

import type { PromptDefinition, PromptMessage, PromptProvider, CompletionCallback } from "../../types/index.js";
import type { Logger } from "../../../logger/index.js";
import { withSpan, MCP_ATTRIBUTES, SpanKind } from "../../../telemetry/index.js";
import { BaseRegistry } from "./base-registry.js";
import { enforceScopeOrThrow } from "./scope-enforcement.js";

// ============================================================================
// Constants
// ============================================================================

const SdkBindingMessages = {
  PROMPTS_REGISTERED: "Registered %d prompts with SDK",
  PROMPT_REGISTERED: "Registered prompt: %s",
  NO_PROMPTS: "No prompts to register",
  PROMPT_GETTING: "Getting prompt: %s with args %j",
  PROMPT_ERROR: "Error generating prompt %s: %s",
} as const;

// ============================================================================
// SDK Binding Options
// ============================================================================

/**
 * Options for binding prompts to an MCP SDK server.
 * @internal
 */
export interface PromptBindOptions {
  readonly logger: Logger;
}

// ============================================================================
// Prompt Registry Class
// ============================================================================

/**
 * Registry for MCP prompts that implements PromptProvider.
 *
 * Extends BaseRegistry for standard CRUD operations (register, get, has, etc.)
 * and provides `bindToSdk()` for registering prompts with MCP SDK server instances.
 *
 * @example
 * ```typescript
 * import { promptRegistry, definePrompt } from 'mcp-server-framework';
 *
 * // Prompts are auto-registered via definePrompt()
 * definePrompt({ name: 'explain', ... });
 *
 * // Registry can be used directly as a provider
 * builder.withPromptProvider(promptRegistry);
 * ```
 */
export class PromptRegistry extends BaseRegistry<PromptDefinition> implements PromptProvider {
  // ──────────────────────────────────────────────────────────────────────────
  // Factory
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Creates an isolated PromptRegistry (no shared global state).
   *
   * Use for testing or when multiple independent registries are needed.
   */
  static createIsolated(): PromptRegistry {
    return new PromptRegistry();
  }
  // ──────────────────────────────────────────────────────────────────────────
  // BaseRegistry Override
  // ──────────────────────────────────────────────────────────────────────────

  protected override get itemTypeName(): string {
    return "Prompt";
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Generic Registration (Variance-Safe)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a prompt from a generic factory function.
   *
   * Centralizes TypeScript generic variance handling. `PromptDefinition<TInput>`
   * is invariant — `TInput` appears in both covariant (input property) and
   * contravariant (generate parameter) positions via Zod's type mapping.
   * TypeScript requires `as unknown as` because neither type sufficiently
   * overlaps with the other (invariance).
   *
   * @internal Used by definePrompt() — prefer registerOrReplace() for non-generic usage.
   */
  registerFromFactory<TInput extends z.AnyZodObject>(prompt: PromptDefinition<TInput>): boolean {
    // @type-variance — Generic input erased for homogeneous storage; SDK validates at runtime
    return this.registerOrReplace(prompt as unknown as PromptDefinition);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PromptProvider Implementation
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get all registered prompts.
   */
  getPrompts(): ReadonlyArray<PromptDefinition> {
    return this.getAll();
  }

  /**
   * Check if provider has any prompts.
   */
  hasPrompts(): boolean {
    return this.size > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SDK Binding
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Registers prompt definitions with an MCP SDK server instance.
   *
   * Each prompt is registered with:
   * - Schema extraction for SDK's raw shape format
   * - Completable wrapping for prompt autocompletion
   * - OpenTelemetry tracing spans
   * - Structured error handling and logging
   *
   * @param sdk - The MCP SDK server instance
   * @param prompts - Prompt definitions to register
   * @param options - Registration context (logger)
   * @internal
   */
  static bindToSdk(sdk: McpServer, prompts: readonly PromptDefinition[], options: PromptBindOptions): void {
    const { logger } = options;

    if (prompts.length === 0) {
      logger.trace(SdkBindingMessages.NO_PROMPTS);
      return;
    }

    logger.trace(SdkBindingMessages.PROMPTS_REGISTERED, prompts.length);

    for (const prompt of prompts) {
      // @sdk-constraint — SDK registerPrompt expects PromptArgsRawShape (Record<string, ZodType>),
      // NOT a ZodObject.
      const argsShape = PromptRegistry.extractPromptArgsShape(prompt.input);

      // Wrap schema fields with SDK's completable() when a complete callback is provided
      const completableShape =
        argsShape && prompt.complete
          ? PromptRegistry.wrapShapeWithCompletable(argsShape, prompt.complete, logger)
          : argsShape;

      const config: {
        description: string;
        argsSchema?: Record<string, z.ZodTypeAny>;
      } = {
        description: prompt.description,
        ...(completableShape && { argsSchema: completableShape }),
      };

      // @sdk-constraint — registerPrompt generic requires PromptArgsRawShape; config carries extracted shape
      sdk.registerPrompt(
        prompt.name,
        config as Parameters<typeof sdk.registerPrompt>[1],
        async (args: unknown, extra: { authInfo?: { scopes?: readonly string[] } }) => {
          // Scope enforcement (RBAC)
          enforceScopeOrThrow(prompt.requiredScopes, extra.authInfo, "Prompt", prompt.name, logger);

          return withSpan(
            `mcp.prompt.${prompt.name}`,
            async (span) => {
              span.setAttributes({
                [MCP_ATTRIBUTES.PROMPT_NAME]: prompt.name,
                [MCP_ATTRIBUTES.OPERATION]: "prompt_generate",
              });

              logger.trace(SdkBindingMessages.PROMPT_GETTING, prompt.name, args);

              try {
                // @sdk-constraint — SDK prompt callback types args as unknown
                const messages = await prompt.generate(args as Record<string, unknown>);

                span.setAttribute(MCP_ATTRIBUTES.RESULT_CONTENT_COUNT, messages.length);

                return {
                  messages: messages.map((m: PromptMessage) => ({
                    role: m.role,
                    content: { type: "text" as const, text: m.content },
                  })),
                };
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(SdkBindingMessages.PROMPT_ERROR, prompt.name, msg);
                throw new McpError(ErrorCode.InternalError, `Prompt '${prompt.name}' failed: ${msg}`);
              }
            },
            { kind: SpanKind.SERVER },
          );
        },
      );
      logger.trace(SdkBindingMessages.PROMPT_REGISTERED, prompt.name);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private SDK Binding Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extracts the raw shape from a ZodObject for SDK prompt registration.
   *
   * @sdk-constraint — The SDK's `registerPrompt()` passes `argsSchema` directly to
   * `objectFromShape()`, which expects a `Record<string, ZodType>` (raw shape),
   * NOT a ZodObject instance. In contrast, `registerTool()` uses `getZodSchemaObject()`
   * which handles both ZodObject and raw shapes. This asymmetry requires explicit
   * shape extraction for prompts.
   *
   * @param schema - A ZodObject schema (e.g. `z.object({ name: z.string() })`)
   * @returns The raw shape object (e.g. `{ name: z.string() }`) or undefined
   */
  private static extractPromptArgsShape(schema: z.AnyZodObject | undefined): Record<string, z.ZodTypeAny> | undefined {
    if (!schema) return undefined;

    // @type-narrowing — ZodObject.shape is typed as ZodRawShape (Record<string, ZodTypeAny>)
    const shape = schema.shape as Record<string, z.ZodTypeAny>;

    // Empty shapes are valid — SDK handles them (creates z4mini.object({}))
    // but skipping registration entirely for empty schemas is cleaner
    if (Object.keys(shape).length === 0) return undefined;

    return shape;
  }

  /**
   * Wraps Zod schema shape fields with SDK's `completable()` for prompt autocompletion.
   *
   * When a prompt defines a `complete` callback, each field in the args schema is wrapped
   * so the SDK's built-in completion handler can invoke the callback per-field.
   *
   * @sdk-constraint — The SDK checks `isCompletable(field)` on each Zod schema field
   * and uses `getCompleter(field)` to get the completion callback.
   */
  private static wrapShapeWithCompletable(
    shape: Record<string, z.ZodTypeAny>,
    complete: CompletionCallback,
    logger: Logger,
  ): Record<string, z.ZodTypeAny> {
    const wrapped: Record<string, z.ZodTypeAny> = {};

    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      // Clone the schema before wrapping — completable() mutates the Zod object via
      // Object.defineProperty with configurable:false. Since definitions are global
      // singletons (DD-002), a second session would fail with "Cannot redefine property".
      const cloned = fieldSchema.describe(fieldSchema.description ?? "");
      wrapped[fieldName] = completable(cloned, async (value: string) => {
        try {
          const result = await complete(fieldName, value);
          return result.values;
        } catch (error) {
          logger.warn(
            "Completion callback failed for field '%s': %s",
            fieldName,
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      });
    }

    return wrapped;
  }
}

// ============================================================================
// Global Singleton Instance
// ============================================================================

/**
 * Global prompt registry singleton.
 *
 * This instance is used by definePrompt() for auto-registration
 * and by createServer() to discover all prompts.
 */
export const globalPromptRegistry = new PromptRegistry();
