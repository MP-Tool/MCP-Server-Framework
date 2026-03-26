/**
 * OpenTelemetry SDK Initialization
 *
 * Handles the lifecycle of the OpenTelemetry SDK including:
 * - SDK initialization with targeted instrumentation
 * - Trace and metric export via OTLP/HTTP
 * - Prometheus metrics embedded at `/metrics` on the MCP Express server
 * - Graceful shutdown
 *
 * ## Configuration
 *
 * All OTEL settings are routed through the config system (env vars + config file).
 * The framework builds exporters and readers explicitly from the unified config
 * so that both env vars and config file are respected consistently.
 *
 * **Framework-managed** (with defaults):
 * - `OTEL_ENABLED` — Master toggle (default: false)
 * - `OTEL_SERVICE_NAME` — Service name (default: 'mcp-server')
 * - `OTEL_METRICS_EXPORTER` — Metric exporters (default: 'otlp,prometheus')
 * - `OTEL_LOGS_EXPORTER` — Log exporter (default: 'none' — framework has own logger)
 *
 * **Standard OTEL (pass-through, no defaults)**:
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP endpoint URL
 * - `OTEL_TRACES_EXPORTER` — Trace exporter: otlp (default), console, none
 * - `OTEL_LOG_LEVEL` — SDK diagnostic log level
 * - `OTEL_METRIC_EXPORT_INTERVAL` — Periodic metric export interval (ms)
 *
 * ## Environment Variable Synchronization
 *
 * The NodeSDK reads standard OTEL env vars directly from `process.env`
 * for internal auto-configuration. Since the framework's config system
 * deliberately does NOT mutate `process.env` (12-Factor compliance),
 * config-file-only values would be invisible to the SDK.
 *
 * {@link syncOtelEnvironment} bridges this gap by writing config values
 * to `process.env` for keys that are NOT already set, preserving the
 * 12-Factor priority: env var > config file > default.
 *
 * ## DiagLogger / OTEL_LOG_LEVEL
 *
 * `OTEL_LOG_LEVEL` is consumed (deleted) from `process.env` in Step 0
 * of {@link initializeTelemetry}, BEFORE the NodeSDK constructor.
 * Without this, the SDK calls `diag.setLogger(new DiagConsoleLogger(), level)`
 * — writing diagnostics to stdout and corrupting the MCP stdio transport.
 *
 * The framework sets `frameworkDiagLogger` as default DiagLogger,
 * which routes all OTEL diagnostics through the framework's logging
 * pipeline (→ stderr with secret scrubbing and structured formatting).
 * Power users can override via `onBeforeTelemetryInit` callback.
 *
 * ## Why exporters are built manually
 *
 * The SDK's env-var auto-config is bypassed when `traceExporter` or
 * `metricReaders` are passed to the NodeSDK constructor. Since we need
 * to build metric readers manually (for Prometheus embedded mode), AND
 * we want config-file support for all settings, we build both trace
 * and metric exporters explicitly from the unified config.
 *
 * @module server/telemetry/sdk
 */

import type { IncomingMessage, RequestOptions } from "node:http";

// @lazy-otel — All heavy @opentelemetry/* packages are loaded dynamically
// inside initializeTelemetry() to avoid ~15-20 MB memory overhead when
// OTEL is disabled. Only type imports remain static (zero runtime cost).
// See DD-020 for the design rationale.
import type { MetricReader, ViewOptions } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

import { METRIC_NAMES } from "./core/constants.js";

import { logger as baseLogger } from "../logger/index.js";
import { setTraceContextExtractor } from "../logger/core/index.js";
import type { TraceContextExtractor, TraceContext } from "../logger/core/index.js";
import { getFrameworkConfig } from "../config/index.js";
import {
  getTelemetryConfig,
  TELEMETRY_LOG_COMPONENTS,
  TELEMETRY_DEFAULTS,
  SdkLogMessages,
  frameworkDiagLogger,
} from "./core/index.js";
import type { TelemetryConfig } from "./core/index.js";

/**
 * Lazily loaded OTEL modules. Populated by {@link loadOtelModules} on
 * first call to {@link initializeTelemetry}. Null until OTEL is actually enabled.
 */
interface OtelModules {
  NodeSDK: typeof import("@opentelemetry/sdk-node").NodeSDK;
  PeriodicExportingMetricReader: typeof import("@opentelemetry/sdk-metrics").PeriodicExportingMetricReader;
  ConsoleMetricExporter: typeof import("@opentelemetry/sdk-metrics").ConsoleMetricExporter;
  AggregationType: typeof import("@opentelemetry/sdk-metrics").AggregationType;
  OTLPTraceExporter: typeof import("@opentelemetry/exporter-trace-otlp-http").OTLPTraceExporter;
  OTLPMetricExporter: typeof import("@opentelemetry/exporter-metrics-otlp-http").OTLPMetricExporter;
  PrometheusExporter: typeof import("@opentelemetry/exporter-prometheus").PrometheusExporter;
  ConsoleSpanExporter: typeof import("@opentelemetry/sdk-trace-base").ConsoleSpanExporter;
  HttpInstrumentation: typeof import("@opentelemetry/instrumentation-http").HttpInstrumentation;
  ExpressInstrumentation: typeof import("@opentelemetry/instrumentation-express").ExpressInstrumentation;
  envDetector: typeof import("@opentelemetry/resources").envDetector;
  resourceFromAttributes: typeof import("@opentelemetry/resources").resourceFromAttributes;
  ATTR_SERVICE_NAME: string;
  ATTR_SERVICE_VERSION: string;
}

let otelModules: OtelModules | null = null;
let otelModulesPromise: Promise<OtelModules> | null = null;

/**
 * Dynamically loads all @opentelemetry/* packages needed for SDK initialization.
 * Called once on first `initializeTelemetry()` invocation when OTEL is enabled.
 * Cached for subsequent calls. Uses promise caching to prevent double-loading
 * if called concurrently.
 */
async function loadOtelModules(): Promise<OtelModules> {
  if (otelModules) return otelModules;
  if (otelModulesPromise) return otelModulesPromise;

  otelModulesPromise = loadOtelModulesImpl();
  try {
    otelModules = await otelModulesPromise;
    return otelModules;
  } catch (err) {
    // Reset cached promise so a subsequent call can retry (e.g., after
    // installing missing OTEL packages in development).
    otelModulesPromise = null;
    throw err;
  }
}

async function loadOtelModulesImpl(): Promise<OtelModules> {
  const [
    sdkNode,
    sdkMetrics,
    traceOtlpHttp,
    metricsOtlpHttp,
    prometheus,
    sdkTraceBase,
    instrHttp,
    instrExpress,
    resources,
    semconv,
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/exporter-prometheus"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  return {
    NodeSDK: sdkNode.NodeSDK,
    PeriodicExportingMetricReader: sdkMetrics.PeriodicExportingMetricReader,
    ConsoleMetricExporter: sdkMetrics.ConsoleMetricExporter,
    AggregationType: sdkMetrics.AggregationType,
    OTLPTraceExporter: traceOtlpHttp.OTLPTraceExporter,
    OTLPMetricExporter: metricsOtlpHttp.OTLPMetricExporter,
    PrometheusExporter: prometheus.PrometheusExporter,
    ConsoleSpanExporter: sdkTraceBase.ConsoleSpanExporter,
    HttpInstrumentation: instrHttp.HttpInstrumentation,
    ExpressInstrumentation: instrExpress.ExpressInstrumentation,
    envDetector: resources.envDetector,
    resourceFromAttributes: resources.resourceFromAttributes,
    ATTR_SERVICE_NAME: semconv.ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION: semconv.ATTR_SERVICE_VERSION,
  };
}

const logger = baseLogger.child({ component: TELEMETRY_LOG_COMPONENTS.SDK });

/**
 * Framework infrastructure routes excluded from HTTP trace instrumentation.
 *
 * These paths handle liveness/readiness probes and metrics scraping.
 * They fire at high frequency (every 10–30s in Kubernetes) and would
 * flood traces with low-value spans. Filtering is applied via
 * {@link HttpInstrumentation}'s `ignoreIncomingRequestHook`.
 */
const TRACE_IGNORED_ROUTES: ReadonlySet<string> = new Set(["/health", "/ready", "/metrics"]);

/** SDK instance — null when not initialized */
let sdk: InstanceType<OtelModules["NodeSDK"]> | null = null;

/**
 * Prometheus exporter instance — null when OTEL is disabled or
 * 'prometheus' is not in OTEL_METRICS_EXPORTER.
 *
 * Always created with `preventServerStart: true` (embedded mode).
 * The `/metrics` Express route delegates to this exporter via
 * {@link getPrometheusExporter}.
 */
let prometheusExporter: InstanceType<OtelModules["PrometheusExporter"]> | null = null;

/**
 * Initialize the OpenTelemetry SDK.
 * Call this at application startup, before any other code.
 *
 * All @opentelemetry/* packages are loaded dynamically on first call
 * (see DD-020). When OTEL is disabled, no packages are loaded and
 * the function returns immediately — saving ~15-20 MB of memory.
 *
 * Builds both trace and metric exporters from the unified config.
 * Only HTTP and Express instrumentations are loaded — other
 * auto-instrumentations are irrelevant for MCP servers.
 *
 * @param onBeforeInit - Optional callback invoked before SDK construction.
 *   Power users can call `diag.setLogger()` in this callback to override the
 *   framework's default DiagLogger. The callback runs AFTER the framework sets
 *   `frameworkDiagLogger` as default.
 * @returns true if OpenTelemetry was initialized, false if disabled
 *
 * @example
 * ```typescript
 * import { initializeTelemetry } from './telemetry/index.js';
 *
 * const enabled = await initializeTelemetry();
 * ```
 */
export async function initializeTelemetry(onBeforeInit?: () => void): Promise<boolean> {
  let config: Readonly<TelemetryConfig> = getTelemetryConfig();

  if (!config.enabled) {
    logger.trace(SdkLogMessages.INIT_SKIPPED);
    return false;
  }

  logger.info(SdkLogMessages.INIT_START);

  // ── Step 0: Framework DiagLogger Setup ───────────────────────────────
  // Load @opentelemetry/api early (lightweight, ~200 KB — not a heavy SDK package).
  // Set frameworkDiagLogger as the default DiagLogger to route OTEL SDK
  // diagnostics through the framework's logging pipeline (→ stderr).
  // Consume OTEL_LOG_LEVEL from process.env to prevent the NodeSDK
  // constructor from calling diag.setLogger(new DiagConsoleLogger(), level)
  // which would write to stdout and corrupt MCP stdio transport.
  const api = await import("@opentelemetry/api");

  const diagLevelStr = process.env["OTEL_LOG_LEVEL"]?.toUpperCase();
  delete process.env["OTEL_LOG_LEVEL"];

  const diagLevelMap: Record<string, number> = {
    NONE: api.DiagLogLevel.NONE,
    ERROR: api.DiagLogLevel.ERROR,
    WARN: api.DiagLogLevel.WARN,
    INFO: api.DiagLogLevel.INFO,
    DEBUG: api.DiagLogLevel.DEBUG,
    VERBOSE: api.DiagLogLevel.VERBOSE,
    ALL: api.DiagLogLevel.ALL,
  };
  const diagLevel = diagLevelStr ? (diagLevelMap[diagLevelStr] ?? api.DiagLogLevel.WARN) : api.DiagLogLevel.WARN;

  api.diag.setLogger(frameworkDiagLogger, {
    logLevel: diagLevel,
    suppressOverrideMessage: true,
  });

  // ── Step 1: Power-User Pre-Init Hook ─────────────────────────────────
  // Called after default DiagLogger setup. Power users can override
  // the DiagLogger via diag.setLogger(), register instrumentations,
  // or configure propagators here.
  if (onBeforeInit) {
    onBeforeInit();
  }

  // ── Step 2: Lazy-load OTEL packages ──────────────────────────────────
  // All heavy @opentelemetry/* modules are loaded here, not at module parse
  // time. This saves ~15-20 MB when OTEL is disabled (see DD-020).
  // Since OTEL packages are optionalDependencies, gracefully handle the case
  // where they are not installed despite OTEL_ENABLED=true.
  let otel: OtelModules;
  try {
    otel = await loadOtelModules();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(SdkLogMessages.INIT_PACKAGES_MISSING, reason);
    return false;
  }

  // ── Step 3: Env-Var Sync ─────────────────────────────────────────────
  // The NodeSDK reads standard OTEL env vars (OTEL_TRACES_EXPORTER,
  // OTEL_LOGS_EXPORTER, etc.) directly from process.env for its internal
  // auto-configuration.  Our config system merges config-file values
  // into the Zod parse source but does NOT mutate process.env (12-Factor:
  // real env vars must always win).  This means config-file-only settings
  // would be invisible to the SDK's internal env-var checks.
  //
  // syncOtelEnvironment() bridges this gap by writing config values to
  // process.env for keys that are NOT already set, preserving 12-Factor
  // priority (env var > config file > default).
  syncOtelEnvironment(config);

  // ── Step 4: Guard Console Exporters in Stdio Mode ─────────────────
  // Console exporters (ConsoleSpanExporter, ConsoleMetricExporter) write
  // to stdout, which corrupts MCP JSON-RPC protocol in stdio transport.
  // Override "console" → "none" and warn the user.
  if (getFrameworkConfig().MCP_TRANSPORT === "stdio") {
    const hasConsoleTraces = config.tracesExporter?.toLowerCase() === "console";
    const hasConsoleMetrics = config.metricsExporters.includes("console");

    if (hasConsoleTraces || hasConsoleMetrics) {
      logger.warn(SdkLogMessages.CONSOLE_EXPORTER_STDIO_GUARD);
      config = {
        ...config,
        ...(hasConsoleTraces && { tracesExporter: "none" }),
        ...(hasConsoleMetrics && {
          metricsExporters: config.metricsExporters.map((e) => (e === "console" ? "none" : e)),
        }),
      };
    }
  }

  // ── Step 5: Build Resource & Exporters ───────────────────────────────
  // Resource: service identity attributes.
  // Additional attributes can be set via OTEL_RESOURCE_ATTRIBUTES (env only).
  const resource = otel.resourceFromAttributes({
    [otel.ATTR_SERVICE_NAME]: config.serviceName,
    [otel.ATTR_SERVICE_VERSION]: config.serviceVersion,
  });

  // Build trace exporter from config.
  // Defaults to OTLP when not explicitly set.
  const traceExporter = buildTraceExporter(config, otel);

  // Build metric readers from OTEL_METRICS_EXPORTER.
  const metricReaders = buildMetricReaders(config, otel);

  logger.info(SdkLogMessages.METRICS_EXPORTERS_CONFIGURED, config.metricsExporters.join(", "));

  // ── Step 6: Construct & Start SDK ────────────────────────────────────
  // - resourceDetectors: Only OTEL_RESOURCE_ATTRIBUTES (env) is respected.
  //   Host/process/OS auto-detectors are disabled to keep target_info lean.
  // - views: Custom histogram buckets for HTTP and MCP duration metrics.
  //   Default OTEL SDK emits 16 bucket boundaries — reduced to MCP-relevant ranges.
  sdk = new otel.NodeSDK({
    resource,
    ...(traceExporter !== undefined && { traceExporter }),
    metricReaders,
    resourceDetectors: [otel.envDetector],
    views: buildMetricViews(otel),
    instrumentations: [
      new otel.HttpInstrumentation({
        // Suppress trace spans for framework infrastructure routes
        // (health probes, readiness checks, Prometheus scrapes).
        // These fire frequently and produce low-value trace data.
        ignoreIncomingRequestHook: (request: IncomingMessage) => {
          const path = (request.url?.split("?")[0] ?? "").replace(/\/+$/, "");
          return TRACE_IGNORED_ROUTES.has(path);
        },
        // Prevent recursive instrumentation of OTLP exporter HTTP calls.
        // Without this, outgoing requests to the OTLP endpoint (e.g.
        // POST localhost:4318/v1/traces) create additional spans that
        // feed back into the export queue — causing ECONNREFUSED spam
        // when no collector is running.
        ignoreOutgoingRequestHook: (request: RequestOptions) => {
          const host = request.hostname ?? request.host ?? "";
          const endpoint = config.endpoint ?? TELEMETRY_DEFAULTS.OTLP_ENDPOINT;
          try {
            const endpointUrl = new URL(endpoint);
            return host === endpointUrl.hostname || host === endpointUrl.host;
          } catch {
            return false;
          }
        },
      }),
      new otel.ExpressInstrumentation(),
    ],
  });

  sdk.start();

  // Register OTEL trace context extractor in the logger.
  // Uses the plugin interface (DD-023) — the logger has no OTEL dependency.
  // Must happen AFTER sdk.start() so that the API has a registered TracerProvider.
  const otelExtractor: TraceContextExtractor = {
    extract(): TraceContext | undefined {
      const span = api.trace.getActiveSpan();
      if (!span) return undefined;
      const ctx = span.spanContext();
      if (!api.isSpanContextValid(ctx)) return undefined;
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    },
  };
  setTraceContextExtractor(otelExtractor);

  // Log init summary — show OTLP endpoint only when an OTLP exporter is active
  const usesOtlp =
    config.tracesExporter === "otlp" || config.tracesExporter === undefined || config.metricsExporters.includes("otlp");

  logger.info(SdkLogMessages.INIT_SUCCESS, config.serviceName);

  if (usesOtlp) {
    logger.info(
      SdkLogMessages.INIT_SUMMARY_WITH_ENDPOINT,
      config.tracesExporter ?? "otlp",
      config.metricsExporters.join(", "),
      config.endpoint,
    );
  } else {
    logger.info(SdkLogMessages.INIT_SUMMARY, config.tracesExporter ?? "otlp", config.metricsExporters.join(", "));
  }
  return true;
}

/**
 * Shutdown the OpenTelemetry SDK.
 * Call this during application shutdown.
 *
 * @returns Promise that resolves when shutdown is complete
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) {
    logger.trace(SdkLogMessages.SHUTDOWN_SKIPPED);
    return;
  }

  logger.trace(SdkLogMessages.SHUTDOWN_START);

  try {
    await sdk.shutdown();
    sdk = null;
    prometheusExporter = null;
    logger.info(SdkLogMessages.SHUTDOWN_SUCCESS);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(SdkLogMessages.SHUTDOWN_ERROR, errorMessage);
    throw error;
  }
}

/**
 * Check if the SDK is currently initialized.
 *
 * @returns true if SDK is initialized
 */
export function isSdkInitialized(): boolean {
  return sdk !== null;
}

/**
 * Get the Prometheus exporter instance.
 *
 * Returns null when telemetry is disabled, not yet initialized,
 * or 'prometheus' is not in OTEL_METRICS_EXPORTER.
 * Used by the `/metrics` Express route to serve Prometheus metrics.
 *
 * @returns PrometheusExporter instance or null
 */
export function getPrometheusExporter(): unknown {
  return prometheusExporter;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Synchronize framework config values to `process.env` for the NodeSDK.
 *
 * The framework's config system resolves values from env vars, config files,
 * and defaults into a unified `TelemetryConfig` but deliberately does NOT
 * mutate `process.env` (12-Factor compliance). However, the NodeSDK reads
 * several `OTEL_*` env vars directly from `process.env` for its internal
 * auto-configuration (e.g., log exporter, trace exporter selection).
 *
 * This function bridges the gap by writing config values to `process.env`
 * **only for keys that are not already set**. This preserves 12-Factor
 * priority: real env vars always override config file values.
 *
 * Synchronized variables:
 * - `OTEL_TRACES_EXPORTER` — Prevents SDK from auto-enabling OTLP traces
 * - `OTEL_LOGS_EXPORTER` — Prevents SDK from auto-enabling OTLP logs
 * - `OTEL_SERVICE_NAME` — Ensures SDK resource matches framework config
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` — Ensures OTLP endpoint is consistent
 *
 * **Note**: `OTEL_LOG_LEVEL` is intentionally NOT synced here. It is
 * consumed (deleted) in Step 1 of {@link initializeTelemetry} to prevent
 * the NodeSDK constructor from setting DiagConsoleLogger (→ stdout).
 *
 * @param config - Resolved telemetry configuration
 */
function syncOtelEnvironment(config: TelemetryConfig): void {
  // Helper: only set env var if not already defined by the environment.
  // This preserves 12-Factor priority (real env var > config file > default).
  const setIfAbsent = (key: string, value: string | undefined): void => {
    if (value !== undefined && !process.env[key]) {
      process.env[key] = value;
    }
  };

  // Trace exporter: prevents "OTEL_TRACES_EXPORTER is empty" warning
  setIfAbsent("OTEL_TRACES_EXPORTER", config.tracesExporter);

  // Log exporter: prevents SDK from auto-enabling OTLP log export.
  // Framework default is 'none' (own logger handles all logging).
  setIfAbsent("OTEL_LOGS_EXPORTER", config.logsExporter);

  // Service name: ensures SDK resource detection matches framework config
  setIfAbsent("OTEL_SERVICE_NAME", config.serviceName);

  // OTLP endpoint: ensures exporters use the config-file endpoint
  setIfAbsent("OTEL_EXPORTER_OTLP_ENDPOINT", config.endpoint);
}

/**
 * Build the trace exporter from config.
 *
 * - `'none'` — No trace export (returns undefined)
 * - `'console'` — ConsoleSpanExporter (for debugging)
 * - `'otlp'` or unset — OTLPTraceExporter with optional endpoint
 *
 * @param config - Telemetry configuration
 * @param otel - Lazily loaded OTEL modules
 * @returns SpanExporter instance or undefined (no tracing)
 */
function buildTraceExporter(config: TelemetryConfig, otel: OtelModules): SpanExporter | undefined {
  const exporter = config.tracesExporter?.toLowerCase() ?? "otlp";

  switch (exporter) {
    case "none":
      logger.debug(SdkLogMessages.TRACE_EXPORTER_CONFIGURED, "none");
      return undefined;

    case "console":
      logger.debug(SdkLogMessages.TRACE_EXPORTER_CONFIGURED, "console");
      return new otel.ConsoleSpanExporter();

    case "otlp":
    default: {
      if (exporter !== "otlp") {
        logger.warn(SdkLogMessages.UNKNOWN_TRACE_EXPORTER, exporter);
      }
      // OTLPTraceExporter reads OTEL_EXPORTER_OTLP_ENDPOINT from env natively,
      // but we pass the config value explicitly to support config-file-based setup.
      const url = `${config.endpoint}/v1/traces`;
      logger.debug(SdkLogMessages.TRACE_EXPORTER_CONFIGURED, `otlp (endpoint: ${url})`);
      return new otel.OTLPTraceExporter({ url });
    }
  }
}

/**
 * Build metric readers from the configured exporter list.
 *
 * Supported values in `OTEL_METRICS_EXPORTER`:
 * - `'otlp'` — OTLP/HTTP metric export
 * - `'prometheus'` — Embedded Prometheus exporter at `/metrics`
 * - `'console'` — Console metric exporter (for debugging)
 * - `'none'` — No metrics export
 *
 * Unknown values are silently ignored.
 *
 * @param config - Telemetry configuration
 * @param otel - Lazily loaded OTEL modules
 * @returns Array of MetricReader instances
 */
function buildMetricReaders(config: TelemetryConfig, otel: OtelModules): MetricReader[] {
  const readers: MetricReader[] = [];

  for (const exporterName of config.metricsExporters) {
    switch (exporterName) {
      case "otlp": {
        // OTLPMetricExporter reads endpoint from env natively,
        // but we pass it explicitly to support config-file-based setup.
        const url = `${config.endpoint}/v1/metrics`;
        const otlpReader = new otel.PeriodicExportingMetricReader({
          exporter: new otel.OTLPMetricExporter({ url }),
          ...(config.metricExportInterval && {
            exportIntervalMillis: config.metricExportInterval,
          }),
        });
        readers.push(otlpReader);
        break;
      }

      case "prometheus": {
        // Embedded mode: preventServerStart stops PrometheusExporter from
        // binding its own HTTP server. Metrics are served by the Express
        // /metrics route via getPrometheusExporter().
        prometheusExporter = new otel.PrometheusExporter({
          preventServerStart: true,
        });
        readers.push(prometheusExporter);
        logger.debug(SdkLogMessages.PROMETHEUS_EXPORTER_ADDED);
        break;
      }

      case "console": {
        const consoleReader = new otel.PeriodicExportingMetricReader({
          exporter: new otel.ConsoleMetricExporter(),
          ...(config.metricExportInterval && {
            exportIntervalMillis: config.metricExportInterval,
          }),
        });
        readers.push(consoleReader);
        break;
      }

      case "none":
        // Explicit no-op — skip metric export entirely
        break;

      default:
        logger.warn(SdkLogMessages.UNKNOWN_METRIC_EXPORTER, exporterName);
        break;
    }
  }

  return readers;
}

// ============================================================================
// Metric Views
// ============================================================================

/**
 * Reduced histogram bucket boundaries for HTTP request duration (OLD semconv).
 *
 * Metric: `http.server.duration` (milliseconds).
 * Default OTEL SDK has 16 boundaries (0, 5, 10, 25, 50, 75, 100, 250, 500,
 * 750, 1000, 2500, 5000, 7500, 10000). For MCP servers, 9 buckets covering
 * the common response time range (5ms–10s) are sufficient.
 *
 * Active when `OTEL_SEMCONV_STABILITY_OPT_IN` is unset or contains `http/dup`.
 */
const HTTP_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];

/**
 * Histogram bucket boundaries for HTTP request duration (stable semconv).
 *
 * Metric: `http.server.request.duration` (seconds).
 * Active when `OTEL_SEMCONV_STABILITY_OPT_IN` contains `http` or `http/dup`.
 * Values are the same ranges as {@link HTTP_DURATION_BUCKETS_MS} converted to
 * seconds, with finer sub-10ms resolution added.
 */
const HTTP_DURATION_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5];

/**
 * Histogram bucket boundaries for MCP request duration.
 *
 * MCP tool handlers typically respond in 1ms–5s. Finer granularity at the
 * low end (1–50ms) captures fast tools; the tail (1s–10s) covers API calls.
 */
const MCP_DURATION_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];

/**
 * Builds OpenTelemetry metric views with custom histogram bucket boundaries.
 *
 * Overrides the default OTEL bucket set (16 boundaries) with MCP-relevant
 * ranges for both HTTP and MCP duration histograms, reducing Prometheus
 * cardinality while preserving useful percentile resolution.
 *
 * Two HTTP views are registered to cover both semconv variants:
 * - `http.server.duration` (OLD, milliseconds) — default behavior
 * - `http.server.request.duration` (stable, seconds) — active when
 *   `OTEL_SEMCONV_STABILITY_OPT_IN` includes `http` or `http/dup`
 *
 * Both views are always registered; the SDK only applies a view when
 * its `instrumentName` matches an actually emitted metric.
 *
 * @returns Array of ViewOptions for NodeSDK configuration
 */
function buildMetricViews(otel: OtelModules): ViewOptions[] {
  return [
    // OLD semconv: http.server.duration (milliseconds)
    {
      instrumentName: "http.server.duration",
      aggregation: {
        type: otel.AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: HTTP_DURATION_BUCKETS_MS },
      },
    },
    // Stable semconv: http.server.request.duration (seconds)
    // Active when OTEL_SEMCONV_STABILITY_OPT_IN=http or http/dup
    {
      instrumentName: "http.server.request.duration",
      aggregation: {
        type: otel.AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: HTTP_DURATION_BUCKETS_S },
      },
    },
    {
      instrumentName: METRIC_NAMES.REQUEST_DURATION,
      aggregation: {
        type: otel.AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: { boundaries: MCP_DURATION_BUCKETS },
      },
    },
  ];
}
