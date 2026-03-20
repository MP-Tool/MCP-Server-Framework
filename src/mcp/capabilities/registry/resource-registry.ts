/**
 * Resource Registry
 *
 * Global registry for MCP resources and resource templates that implements ResourceProvider.
 * Uses composition with BaseRegistry for DRY CRUD operations.
 *
 * The registry is the single authority for resource definitions:
 * - Storage: CRUD operations via BaseRegistry
 * - SDK Binding: `bindToSdk()` registers resources with MCP SDK server instances
 *
 * @module mcp/capabilities/registry/resource-registry
 */

import { ResourceTemplate as SdkResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { type z, ZodError } from "zod";

import type {
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  ResourceProvider,
  CompletionCallback,
} from "../../types/index.js";
import type { Logger } from "../../../logger/index.js";
import { withSpan, MCP_ATTRIBUTES, SpanKind } from "../../../telemetry/index.js";
import { BaseRegistry } from "./base-registry.js";
import { enforceScopeOrThrow } from "./scope-enforcement.js";
import { logger as baseLogger } from "../../../logger/index.js";

const logger = baseLogger.child({ component: "resource-registry" });

// ============================================================================
// Constants
// ============================================================================

const SdkBindingMessages = {
  RESOURCES_REGISTERED: "Registered %d resources and %d templates with SDK",
  RESOURCE_REGISTERED: "Registered resource: %s (%s)",
  TEMPLATE_REGISTERED: "Registered resource template: %s (%s)",
  TEMPLATE_LIST_FAILED: "Failed to list resources for template %s: %s",
  NO_RESOURCES: "No resources to register",
  RESOURCE_READ_ERROR: "Error reading resource %s: %s",
  TEMPLATE_READ_ERROR: "Error reading resource template %s: %s",
  RESOURCE_READING: "Reading resource: %s",
  TEMPLATE_READING: "Reading resource template: %s with variables %j",
  TEMPLATE_VALIDATION_FAILED: "Resource template %s: parameter validation failed: %s",
} as const;

const RegistryLogMessages = {
  DUPLICATE_URI: 'Resource URI conflict: "%s" registers URI "%s" which is already used by "%s"',
} as const;

// ============================================================================
// SDK Binding Options
// ============================================================================

/**
 * Options for binding resources to an MCP SDK server.
 * @internal
 */
export interface ResourceBindOptions {
  readonly logger: Logger;
}

// ============================================================================
// Internal Registry Classes (extend BaseRegistry for CRUD)
// ============================================================================

/**
 * Internal registry for static resources.
 * @internal
 */
class StaticResourceRegistry extends BaseRegistry<ResourceStaticDefinition> {
  protected override get itemTypeName(): string {
    return "Resource";
  }
}

/**
 * Internal registry for resource templates.
 * @internal
 */
class ResourceTemplateRegistry extends BaseRegistry<ResourceTemplateDefinition> {
  protected override get itemTypeName(): string {
    return "Template";
  }
}

// ============================================================================
// Resource Registry Class
// ============================================================================

/**
 * Composite registry for MCP resources and templates.
 *
 * Uses two internal BaseRegistry instances to eliminate code duplication
 * while maintaining separate namespaces for resources and templates.
 *
 * Implements ResourceProvider for direct use with McpServerBuilder.
 *
 * @example
 * ```typescript
 * import { resourceRegistry, defineResource } from 'mcp-server-framework';
 *
 * // Resources are auto-registered via defineResource()
 * defineResource({ name: 'config', uri: 'app://config', ... });
 *
 * // Registry can be used directly as a provider
 * builder.withResourceProvider(resourceRegistry);
 * ```
 */
export class ResourceRegistry implements ResourceProvider {
  /** Internal registry for static resources */
  private readonly resourceRegistry = new StaticResourceRegistry();

  /** Internal registry for resource templates */
  private readonly templateRegistry = new ResourceTemplateRegistry();

  // ──────────────────────────────────────────────────────────────────────────
  // Factory
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Creates an isolated ResourceRegistry (no shared global state).
   *
   * Used for testing.
   */
  static createIsolated(): ResourceRegistry {
    return new ResourceRegistry();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Resource Registration Methods (delegated to internal registry)
  // ──────────────────────────────────────────────────────────────────────────

  /** Register a static resource. Throws if name exists. Warns on URI conflict. */
  registerResource(resource: ResourceStaticDefinition): void {
    this.warnOnDuplicateResourceUri(resource.name, resource.uri);
    this.resourceRegistry.register(resource);
  }

  /** Register a static resource, replacing any existing. Warns on URI conflict. */
  registerOrReplaceResource(resource: ResourceStaticDefinition): void {
    this.warnOnDuplicateResourceUri(resource.name, resource.uri);
    this.resourceRegistry.registerOrReplace(resource);
  }

  /** Unregister a resource by name. */
  unregisterResource(name: string): boolean {
    return this.resourceRegistry.unregister(name);
  }

  /** Get a resource by name. */
  getResource(name: string): ResourceStaticDefinition | undefined {
    return this.resourceRegistry.get(name);
  }

  /** Check if a resource exists. */
  hasResource(name: string): boolean {
    return this.resourceRegistry.has(name);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Template Registration Methods (delegated to internal registry)
  // ──────────────────────────────────────────────────────────────────────────

  /** Register a resource template. Throws if name exists. */
  registerTemplate(template: ResourceTemplateDefinition): void {
    this.templateRegistry.register(template);
  }

  /** Register a template, replacing any existing. */
  registerOrReplaceTemplate(template: ResourceTemplateDefinition): void {
    this.templateRegistry.registerOrReplace(template);
  }

  /** Unregister a template by name. */
  unregisterTemplate(name: string): boolean {
    return this.templateRegistry.unregister(name);
  }

  /** Get a template by name. */
  getTemplate(name: string): ResourceTemplateDefinition | undefined {
    return this.templateRegistry.get(name);
  }

  /** Check if a template exists. */
  hasTemplate(name: string): boolean {
    return this.templateRegistry.has(name);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Generic Registration (Variance-Safe)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a template from a generic factory function.
   *
   * Centralizes TypeScript generic variance handling. `ResourceTemplateDefinition<TInput>`
   * is invariant — `TInput` appears in both covariant (input property) and
   * contravariant (read parameter) positions via Zod's type mapping.
   * TypeScript requires `as unknown as` because neither type sufficiently
   * overlaps with the other (invariance).
   *
   * @internal Used by defineResourceTemplate() — prefer registerOrReplaceTemplate() for non-generic usage.
   */
  registerTemplateFromFactory<TInput extends z.AnyZodObject>(template: ResourceTemplateDefinition<TInput>): void {
    // @type-variance — Generic input erased for homogeneous storage; SDK validates at runtime
    this.templateRegistry.registerOrReplace(template as unknown as ResourceTemplateDefinition);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Clear Methods
  // ──────────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // URI Conflict Detection
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Warn when a new resource registers a URI already in use by another resource.
   * Name-based dedup is handled by BaseRegistry; this checks for URI-level conflicts
   * across the static resource registry.
   */
  private warnOnDuplicateResourceUri(newName: string, uri: string): void {
    for (const existing of this.resourceRegistry.getAll()) {
      if (existing.uri === uri && existing.name !== newName) {
        logger.warn(RegistryLogMessages.DUPLICATE_URI, newName, uri, existing.name);
        return;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Clear Methods
  // ──────────────────────────────────────────────────────────────────────────

  /** Clear all resources. */
  clearResources(): void {
    this.resourceRegistry.clear();
  }

  /** Clear all templates. */
  clearTemplates(): void {
    this.templateRegistry.clear();
  }

  /** Clear all resources and templates. */
  clear(): void {
    this.resourceRegistry.clear();
    this.templateRegistry.clear();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Size Properties (computed from internal registries)
  // ──────────────────────────────────────────────────────────────────────────

  /** Number of registered resources. */
  get resourceCount(): number {
    return this.resourceRegistry.size;
  }

  /** Number of registered templates. */
  get templateCount(): number {
    return this.templateRegistry.size;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ResourceProvider Implementation
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get all registered static resources.
   */
  getResources(): ReadonlyArray<ResourceStaticDefinition> {
    return this.resourceRegistry.getAll();
  }

  /**
   * Get all registered templates.
   */
  getTemplates(): ReadonlyArray<ResourceTemplateDefinition> {
    return this.templateRegistry.getAll();
  }

  /**
   * Check if provider has any resources or templates.
   */
  hasResources(): boolean {
    return this.resourceRegistry.size > 0 || this.templateRegistry.size > 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SDK Binding
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Registers all resources (static + templates) with an MCP SDK server instance.
   *
   * Each resource is registered with:
   * - OpenTelemetry tracing spans for read operations
   * - Structured error handling and logging
   * - URI template variable extraction and completion callbacks
   *
   * @param sdk - The MCP SDK server instance
   * @param resources - Static resource definitions
   * @param templates - Resource template definitions
   * @param options - Registration context (logger)
   * @internal
   */
  static bindToSdk(
    sdk: McpServer,
    resources: readonly ResourceStaticDefinition[],
    templates: readonly ResourceTemplateDefinition[],
    options: ResourceBindOptions,
  ): void {
    const { logger } = options;

    if (resources.length === 0 && templates.length === 0) {
      logger.trace(SdkBindingMessages.NO_RESOURCES);
      return;
    }

    logger.trace(SdkBindingMessages.RESOURCES_REGISTERED, resources.length, templates.length);

    // Register static resources
    for (const resource of resources) {
      sdk.registerResource(
        resource.name,
        resource.uri,
        { description: resource.description, mimeType: resource.mimeType },
        async (_uri: URL, extra: { authInfo?: { scopes?: readonly string[] } }) => {
          // Scope enforcement (RBAC)
          enforceScopeOrThrow(resource.requiredScopes, extra.authInfo, "Resource", resource.uri, logger);

          return withSpan(
            `mcp.resource.read`,
            async (span) => {
              span.setAttributes({
                [MCP_ATTRIBUTES.RESOURCE_URI]: resource.uri,
                [MCP_ATTRIBUTES.OPERATION]: "resource_read",
              });

              logger.trace(SdkBindingMessages.RESOURCE_READING, resource.uri);

              try {
                const content = await resource.read();

                if (typeof content === "string") {
                  return {
                    contents: [
                      {
                        uri: resource.uri,
                        mimeType: resource.mimeType,
                        text: content,
                      },
                    ],
                  };
                } else {
                  const base64 = Buffer.from(content).toString("base64");
                  return {
                    contents: [
                      {
                        uri: resource.uri,
                        mimeType: resource.mimeType,
                        blob: base64,
                      },
                    ],
                  };
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(SdkBindingMessages.RESOURCE_READ_ERROR, resource.uri, msg);
                throw error;
              }
            },
            { kind: SpanKind.SERVER },
          );
        },
      );
      logger.trace(SdkBindingMessages.RESOURCE_REGISTERED, resource.name, resource.uri);
    }

    // Register templates
    for (const template of templates) {
      const completeCallbacks = template.complete
        ? ResourceRegistry.buildResourceCompleteCallbacks(template.uriTemplate, template.complete)
        : undefined;

      const sdkTemplate = new SdkResourceTemplate(template.uriTemplate, {
        list: template.list
          ? async () => {
              try {
                const items = await template.list!();
                return {
                  resources: items.map((item) => ({
                    uri: item.uri,
                    name: item.name ?? template.name,
                    description: item.description ?? template.description,
                    mimeType: item.mimeType ?? template.mimeType,
                  })),
                };
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(SdkBindingMessages.TEMPLATE_LIST_FAILED, template.uriTemplate, msg);
                return { resources: [] };
              }
            }
          : undefined,
        ...(completeCallbacks && { complete: completeCallbacks }),
      });

      sdk.registerResource(
        template.name,
        sdkTemplate,
        { description: template.description, mimeType: template.mimeType },
        async (
          _uri: URL,
          variables: Record<string, string | string[]>,
          extra: { authInfo?: { scopes?: readonly string[] } },
        ) => {
          // Scope enforcement (RBAC)
          enforceScopeOrThrow(template.requiredScopes, extra.authInfo, "Resource", template.uriTemplate, logger);

          return withSpan(
            `mcp.resource.read`,
            async (span) => {
              span.setAttributes({
                [MCP_ATTRIBUTES.RESOURCE_TEMPLATE]: template.uriTemplate,
                [MCP_ATTRIBUTES.OPERATION]: "resource_read",
              });

              logger.trace(SdkBindingMessages.TEMPLATE_READING, template.uriTemplate, variables);

              // Convert string[] to string for simple templates
              const params: Record<string, string> = {};
              for (const [key, value] of Object.entries(variables)) {
                params[key] = Array.isArray(value) ? (value[0] ?? "") : value;
              }

              // Validate params against Zod schema if provided (DD JSDoc contract)
              if (template.input) {
                try {
                  await template.input.parseAsync(params);
                } catch (validationError) {
                  const msg =
                    validationError instanceof ZodError
                      ? validationError.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
                      : String(validationError);
                  logger.warn(SdkBindingMessages.TEMPLATE_VALIDATION_FAILED, template.uriTemplate, msg);
                  throw new McpError(ErrorCode.InvalidParams, `Invalid resource template parameters: ${msg}`);
                }
              }

              try {
                const content = await template.read(params);

                // Construct URI from template for the response
                const uri = template.uriTemplate.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);

                if (typeof content === "string") {
                  return {
                    contents: [{ uri, mimeType: template.mimeType, text: content }],
                  };
                } else {
                  const base64 = Buffer.from(content).toString("base64");
                  return {
                    contents: [{ uri, mimeType: template.mimeType, blob: base64 }],
                  };
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(SdkBindingMessages.TEMPLATE_READ_ERROR, template.uriTemplate, msg);
                throw error;
              }
            },
            { kind: SpanKind.SERVER },
          );
        },
      );
      logger.trace(SdkBindingMessages.TEMPLATE_REGISTERED, template.name, template.uriTemplate);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private SDK Binding Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Extracts variable names from a URI template string (RFC 6570).
   *
   * @param uriTemplate - URI template pattern (e.g., 'notes://note/{noteId}')
   * @returns Array of variable names (e.g., ['noteId'])
   */
  private static extractUriTemplateVariables(uriTemplate: string): string[] {
    const matches = uriTemplate.matchAll(/\{(\w+)\}/g);
    return [...matches].map((m) => m[1]!);
  }

  /**
   * Bridges framework's unified `complete(argName, argValue)` callback to SDK's
   * per-variable `{ [variable]: (value) => string[] }` format.
   *
   * @sdk-constraint — SDK ResourceTemplate expects separate callbacks keyed by variable name.
   * The framework provides a single callback to reduce boilerplate.
   */
  private static buildResourceCompleteCallbacks(
    uriTemplate: string,
    complete: CompletionCallback,
  ): Record<string, (value: string) => string[] | Promise<string[]>> {
    const variables = ResourceRegistry.extractUriTemplateVariables(uriTemplate);
    const callbacks: Record<string, (value: string) => string[] | Promise<string[]>> = {};

    for (const variable of variables) {
      callbacks[variable] = async (value: string) => {
        try {
          const result = await complete(variable, value);
          return result.values;
        } catch (error) {
          logger.warn(
            "Completion callback failed for variable '%s': %s",
            variable,
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      };
    }

    return callbacks;
  }
}

// ============================================================================
// Global Singleton Instance
// ============================================================================

/**
 * Global resource registry singleton.
 *
 * This instance is used by defineResource() and defineResourceTemplate()
 * for auto-registration and by createServer() to discover all resources.
 */
export const globalResourceRegistry = new ResourceRegistry();
