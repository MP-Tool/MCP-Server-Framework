/**
 * Telemetry Module Constants
 *
 * Centralized constants for the OpenTelemetry integration module including:
 * - Semantic attribute names for MCP operations
 * - Metric attribute names
 * - Log component identifiers
 * - Log messages
 * - Metric names
 *
 * @module server/telemetry/core/constants
 */

// ============================================================================
// Configuration Constants
// ============================================================================

/**
 * Default telemetry configuration values.
 */
export const TELEMETRY_DEFAULTS = {
  /** Default service name (last resort when options.name is also missing) */
  SERVICE_NAME: "mcp-server",
  /** Default service version when not available */
  SERVICE_VERSION_FALLBACK: "unknown",
  /** Default metric exporters */
  METRICS_EXPORTER: "otlp,prometheus",
  /** OTEL standard OTLP/HTTP endpoint (per OTEL specification) */
  OTLP_ENDPOINT: "http://localhost:4318",
} as const;

/**
 * Environment variable names for telemetry configuration.
 *
 * Includes both framework-managed and standard OTEL variables.
 * Standard vars are parsed in the config system so they can be set
 * via config file, then passed through to the SDK and exporters.
 * See: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
 */
export const TELEMETRY_ENV_VARS = {
  // Framework-managed
  /** Enable/disable OpenTelemetry (framework master toggle) */
  OTEL_ENABLED: "OTEL_ENABLED",
  /** Service name (also read natively by SDK resource detector) */
  OTEL_SERVICE_NAME: "OTEL_SERVICE_NAME",
  /** Metric exporters: otlp, prometheus, console, none (comma-separated) */
  OTEL_METRICS_EXPORTER: "OTEL_METRICS_EXPORTER",

  // Standard OTEL (pass-through)
  /** OTLP exporter endpoint URL */
  OTEL_EXPORTER_OTLP_ENDPOINT: "OTEL_EXPORTER_OTLP_ENDPOINT",
  /** Trace exporter selection */
  OTEL_TRACES_EXPORTER: "OTEL_TRACES_EXPORTER",
  /** Log exporter selection (default: 'none' — framework has own logger) */
  OTEL_LOGS_EXPORTER: "OTEL_LOGS_EXPORTER",
  /** SDK diagnostic log level */
  OTEL_LOG_LEVEL: "OTEL_LOG_LEVEL",
  /** Periodic metric export interval (ms) */
  OTEL_METRIC_EXPORT_INTERVAL: "OTEL_METRIC_EXPORT_INTERVAL",
} as const;

// ============================================================================
// Semantic Attribute Names
// ============================================================================

/**
 * Semantic attribute names for MCP operations.
 * Follow OpenTelemetry semantic conventions pattern.
 *
 * Note: Application-specific attributes should be defined in the
 * app layer (src/app/telemetry.ts) to keep the framework generic.
 */
export const MCP_ATTRIBUTES = {
  /** MCP tool name */
  TOOL_NAME: "mcp.tool.name",
  /** MCP resource URI */
  RESOURCE_URI: "mcp.resource.uri",
  /** MCP resource template URI */
  RESOURCE_TEMPLATE: "mcp.resource.template",
  /** MCP prompt name */
  PROMPT_NAME: "mcp.prompt.name",
  /** MCP request ID */
  REQUEST_ID: "mcp.request.id",
  /** MCP session ID */
  SESSION_ID: "mcp.session.id",
  /** Operation type (tool_call, resource_read, prompt_generate) */
  OPERATION: "mcp.operation",
  /** Whether the operation succeeded */
  SUCCESS: "mcp.success",
  /** Result content type count */
  RESULT_CONTENT_COUNT: "mcp.result.content_count",
  /** Whether the result indicates an error */
  RESULT_IS_ERROR: "mcp.result.is_error",
} as const;

/**
 * Semantic attribute names for server metrics.
 */
export const METRIC_ATTRIBUTES = {
  /** Tool name being invoked */
  TOOL_NAME: "tool.name",
  /** Transport type (http, sse, stdio) */
  TRANSPORT: "transport",
  /** Request success status */
  SUCCESS: "success",
  /** Error type */
  ERROR_TYPE: "error.type",
  /** Component where error occurred */
  COMPONENT: "component",
  /** Previous connection state */
  PREVIOUS_STATE: "connection.state.previous",
  /** Current connection state */
  CURRENT_STATE: "connection.state.current",
} as const;

// ============================================================================
// Metric Names
// ============================================================================

/**
 * OpenTelemetry metric instrument names.
 */
export const METRIC_NAMES = {
  /** Counter for total requests */
  REQUESTS_TOTAL: "mcp.server.requests",
  /** Histogram for request duration */
  REQUEST_DURATION: "mcp.server.request.duration",
  /** UpDownCounter for active sessions */
  SESSIONS_ACTIVE: "mcp.server.sessions.active",
  /** Counter for connection state changes */
  CONNECTION_STATE_CHANGES: "mcp.server.connection.state_changes",
  /** Counter for errors */
  ERRORS_TOTAL: "mcp.server.errors",
  /** Gauge for server uptime */
  UPTIME: "mcp.server.uptime",
  /** Gauge for heap memory used */
  MEMORY_HEAP_USED: "mcp.server.memory.heap_used",
  /** Gauge for RSS memory */
  MEMORY_RSS: "mcp.server.memory.rss",
} as const;

/**
 * Metric descriptions for documentation.
 */
export const METRIC_DESCRIPTIONS = {
  [METRIC_NAMES.REQUESTS_TOTAL]: "Total number of MCP requests processed",
  [METRIC_NAMES.REQUEST_DURATION]: "Duration of MCP requests in milliseconds",
  [METRIC_NAMES.SESSIONS_ACTIVE]: "Number of active sessions",
  [METRIC_NAMES.CONNECTION_STATE_CHANGES]: "Number of connection state changes",
  [METRIC_NAMES.ERRORS_TOTAL]: "Total number of errors",
  [METRIC_NAMES.UPTIME]: "Server uptime in seconds",
  [METRIC_NAMES.MEMORY_HEAP_USED]: "Heap memory used in bytes",
  [METRIC_NAMES.MEMORY_RSS]: "Resident set size in bytes",
} as const;

/**
 * Metric units following OpenTelemetry conventions.
 */
export const METRIC_UNITS = {
  COUNT: "1",
  MILLISECONDS: "ms",
  SECONDS: "s",
  BYTES: "By",
} as const;

// ============================================================================
// Log Component Identifiers
// ============================================================================

/**
 * Logger component identifiers for the telemetry module.
 * Used for consistent log categorization.
 */
export const TELEMETRY_LOG_COMPONENTS = {
  /** SDK initialization component */
  SDK: "TelemetrySDK",
  /** Tracing utilities component */
  TRACING: "Tracing",
  /** Metrics manager component */
  METRICS: "Metrics",
  /** Configuration component */
  CONFIG: "TelemetryConfig",
} as const;

// ============================================================================
// Log Messages
// ============================================================================

/**
 * Centralized log messages for SDK lifecycle.
 */
export const SdkLogMessages = {
  // Initialization
  INIT_START: "Initializing OpenTelemetry SDK",
  INIT_SUCCESS: "OpenTelemetry initialized: service=%s, endpoint=%s",
  INIT_SKIPPED: "OpenTelemetry disabled - skipping initialization",
  INIT_PACKAGES_MISSING:
    "OpenTelemetry packages not installed (%s). OTEL_ENABLED=true requires: npm install @opentelemetry/sdk-node @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/exporter-prometheus @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/resources @opentelemetry/semantic-conventions — disabling telemetry",

  // Metric exporters
  METRICS_EXPORTERS_CONFIGURED: "Metric exporters configured: %s",
  PROMETHEUS_EXPORTER_ADDED: "Prometheus MetricReader added (embedded at /metrics)",
  UNKNOWN_METRIC_EXPORTER: "Unknown metric exporter '%s' — ignored. Supported: otlp, prometheus, console, none",

  // Trace exporter
  TRACE_EXPORTER_CONFIGURED: "Trace exporter configured: %s",
  UNKNOWN_TRACE_EXPORTER: "Unknown trace exporter '%s' — falling back to OTLP. Supported: otlp, console, none",

  // Shutdown
  SHUTDOWN_START: "Shutting down OpenTelemetry SDK",
  SHUTDOWN_SUCCESS: "OpenTelemetry SDK shut down successfully",
  SHUTDOWN_ERROR: "Error shutting down OpenTelemetry SDK: %s",
  SHUTDOWN_SKIPPED: "OpenTelemetry SDK not initialized - nothing to shutdown",
} as const;

// ============================================================================
// Transport Type Constants
// ============================================================================

/**
 * Known transport types for session tracking.
 */
export const TRANSPORT_TYPES = {
  HTTP: "http",
  SSE: "sse",
  STDIO: "stdio",
} as const;
