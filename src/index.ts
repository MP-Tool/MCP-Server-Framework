/**
 * MCP Server Framework
 *
 * A production-ready framework for building Model Context Protocol servers.
 * Provides a clean, type-safe API for defining tools, resources, and prompts.
 *
 * @example Basic Server Setup
 * ```typescript
 * import { createServer, defineTool, text, z } from 'mcp-server-framework';
 *
 * const healthTool = defineTool({
 *   name: 'health',
 *   description: 'Check server health',
 *   input: z.object({}),
 *   handler: async () => text('OK'),
 * });
 *
 * const { start } = createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'stdio' },
 * });
 *
 * await start();
 * ```
 *
 * ## Subpath Imports (Advanced)
 *
 * Internal modules are available via subpath imports for advanced use cases:
 * ```typescript
 * import { SessionManagerImpl } from 'mcp-server-framework/session';
 * import { startHttpTransport, createExpressApp } from 'mcp-server-framework/http';
 * import { getActiveSpan, SpanKind } from 'mcp-server-framework/telemetry';
 * import { FrameworkErrorFactory } from 'mcp-server-framework/errors';
 * import { Logger } from 'mcp-server-framework/logger';
 * import { getFrameworkConfig } from 'mcp-server-framework/config';
 * ```
 *
 * @packageDocumentation
 * @module mcp-server-framework
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PRIMARY API
// ═══════════════════════════════════════════════════════════════════════════════

// Server creation
export { createServer } from "./server/index.js";
export { McpServerBuilder } from "./server/index.js";

// Definition helpers (auto-register in global registries)
export { defineTool } from "./mcp/capabilities/tools/index.js";
export { defineResource, defineResourceTemplate } from "./mcp/capabilities/resources/index.js";
export { definePrompt } from "./mcp/capabilities/prompts/index.js";
export { defineApp } from "./mcp/capabilities/apps/index.js";
export { defineTask } from "./mcp/capabilities/tasks/index.js";

// Schema validation (Zod re-export — see DD-011)
export { z } from "zod";

// Response helpers
export { text, json, error, image, audio, multi } from "./mcp/responses/index.js";

// Type guards
export { isHttpTransport } from "./server/index.js";
export { isStaticResource, isResourceTemplate } from "./mcp/types/index.js";
export { isFullOAuthProvider } from "./server/auth/index.js";

// Auth provider factories
export { createUpstreamOAuthProvider } from "./server/auth/index.js";
export { createOidcProvider } from "./server/auth/index.js";
export { fetchOidcDiscovery, getOidcDiscovery, clearOidcDiscoveryCache } from "./server/auth/index.js";

// Auth providers (re-export SDK types for consumer convenience)
export { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
export type { ProxyOptions, ProxyEndpoints } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";

// Auth guards
export { requireAuth, requireScope, requireScopes, hasScope, hasAllScopes, hasAnyScope } from "./server/auth/index.js";

// Auth middleware
export { createBearerAuth, createCustomHeaderAuth } from "./server/middleware/index.js";
export type { BearerAuthOptions, CustomHeaderAuthOptions } from "./server/middleware/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

// --- Auth types ---
export type {
  AuthInfo,
  OAuthServerProvider,
  TokenVerifier,
  AuthProvider,
  AuthenticatedExtra,
  AuthOptions,
  UpstreamOAuthOptions,
  UpstreamOAuthProviderResult,
  UpstreamEndpoints,
  OidcProviderOptions,
  OidcDiscoveryDocument,
} from "./server/auth/index.js";

// --- Server creation ---
export type { CreateServerOptions, CreateServerResult, ServerBuilder } from "./server/index.js";

// --- Server configuration & lifecycle ---
export type {
  TransportMode,
  BaseHttpTransportOptions,
  StdioTransportOptions,
  HttpTransportOptions,
  HttpsTransportOptions,
  TlsConfig,
  TransportOptions,
  ServerCapabilities,
  ReadinessConfig,
  SessionConfigOptions,
  ServerOptions,
  ServerInstance,
  ServerState,
  ServerLifecycleHooks,
  ShutdownConfig,
} from "./server/index.js";

// --- MCP protocol definitions ---
export type {
  // Completions
  CompletionResult,
  CompletionCallback,
  // Tools
  ToolAnnotations,
  ToolDefinition,
  ToolProvider,
  // Resources
  BaseResourceDefinition,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  ResourceDefinition,
  TextResourceContent,
  BlobResourceContent,
  ResourceContent,
  ResourceProvider,
  // Prompts
  PromptRole,
  PromptMessage,
  PromptDefinition,
  PromptProvider,
  // Apps
  AppResourceDefinition,
  AppDefinition,
  // Tasks
  TaskSupport,
  TaskToolHandler,
  TaskToolDefinition,
  TaskToolProvider,
} from "./mcp/types/index.js";

// --- Tool context & protocol handlers ---
export type {
  ToolContext,
  TaskCreateContext,
  TaskOperationContext,
  ProgressData,
  ProgressReporter,
  PingHandler,
  HandlersConfig,
} from "./mcp/types/index.js";

// --- Response types ---
export type {
  ToolResponse,
  ContentAudience,
  ContentAnnotations,
  ResponseOptions,
  TextResponseOptions,
  JsonResponseOptions,
  ErrorResponseOptions,
  ImageMimeType,
  ImageResponseOptions,
  AudioMimeType,
  AudioResponseOptions,
} from "./mcp/types/index.js";

// --- EventStore (SDK re-exports for stream resumability) ---
export type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// --- Server→Client request types (SDK re-exports for Sampling, Roots, Elicitation) ---
export type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageRequestParams,
  CreateMessageRequestParamsBase,
  SamplingMessage,
  Root,
  ListRootsResult,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRIES
// ═══════════════════════════════════════════════════════════════════════════════

export {
  ToolRegistry,
  ResourceRegistry,
  PromptRegistry,
  TaskToolRegistry,
  globalToolRegistry,
  globalResourceRegistry,
  globalPromptRegistry,
  globalTaskToolRegistry,
} from "./mcp/capabilities/registry/index.js";

/**
 * `resetAllRegistries` is re-exported from the registry module.
 * Import it directly from the main package:
 * ```typescript
 * import { resetAllRegistries } from 'mcp-server-framework';
 * ```
 */
export { resetAllRegistries } from "./mcp/capabilities/registry/index.js";

export type { RegistryItem } from "./mcp/capabilities/registry/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE — Logger
// ═══════════════════════════════════════════════════════════════════════════════

export { Logger, logger, configureLogger, getLoggerConfig } from "./logger/index.js";

export type { LogLevel, LoggerInterface, LoggerConfig } from "./logger/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE — Errors
// ═══════════════════════════════════════════════════════════════════════════════

export {
  AppError,
  McpProtocolError,
  SessionError,
  TransportError,
  ValidationError,
  ConfigurationError,
  InternalError,
  RegistryError,
  OperationError,
  OperationCancelledError,
  AuthenticationError,
  AuthorizationError,
  FrameworkErrorFactory,
} from "./errors/index.js";

export type {
  ErrorCodeType,
  BaseErrorOptions,
  ValidationErrorOptions,
  ValidationIssue,
  SerializedError,
  FrameworkErrorFactoryType,
} from "./errors/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE — Config
// ═══════════════════════════════════════════════════════════════════════════════

export {
  getFrameworkConfig,
  getConfigSource,
  CONFIG_FILE_ENV_VAR,
  DISCOVERY_FILENAMES,
  registerConfigSection,
  getAppConfig,
  frameworkEnvSchema,
  validateConfigConstraints,
  booleanFromEnv,
  commaSeparatedList,
  optionalCommaSeparatedList,
} from "./config/index.js";

export type { ConfigSource, ConfigFileFormat, FrameworkEnvConfig, ConfigConstraintViolation } from "./config/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE — Telemetry
// ═══════════════════════════════════════════════════════════════════════════════

export {
  initializeTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  getTracer,
  withSpan,
  withSpanSync,
  MCP_ATTRIBUTES,
} from "./telemetry/index.js";

export type { TelemetryConfig, SpanOptions, ServerMetrics, ServerStats } from "./telemetry/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

export {
  parseEnvBoolean,
  getEnvString,
  getEnvOptional,
  interpolate,
  type MessageParams,
  parseDuration,
  formatDuration,
  durationSchema,
} from "./utils/index.js";
