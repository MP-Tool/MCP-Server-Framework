/**
 * Framework Environment Configuration
 *
 * Environment variables for the generic MCP server framework.
 * These settings are NOT application-specific and apply to any MCP server
 * built with this framework.
 *
 * @module config/env
 */

import { z } from "zod";
import {
  booleanFromEnv,
  optionalCommaSeparatedList,
  commaSeparatedList,
  byteSizeSchema,
  durationSchema,
} from "../utils/zod-helpers.js";
import { BYTE_SIZE_REGEX, parseDuration } from "../utils/string-helpers.js";
import { readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ============================================================================
// Version Resolution
// ============================================================================

/** Path to baked-in VERSION file (created during Docker build) */
const VERSION_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "VERSION");

/**
 * Resolve application version from available sources.
 *
 * Single Source of Truth: package.json
 *
 * Resolution:
 * - Docker: Reads from build/VERSION (baked in from package.json during build)
 * - npm run: Uses npm_package_version (injected by npm from package.json)
 *
 * @returns Version string or 'unknown' if resolution fails
 */
function resolveVersion(): string {
  // Docker: VERSION file is baked in during build
  try {
    return readFileSync(VERSION_FILE_PATH, "utf-8").trim();
  } catch (_: unknown) {
    // Not running in Docker container — VERSION file doesn't exist
  }

  // npm run: npm injects version from package.json
  return process.env.npm_package_version ?? "unknown";
}

/** Cached version - resolved once at module load */
const VERSION = resolveVersion();

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Framework environment schema - application-agnostic settings.
 *
 * Includes:
 * - Application metadata (version, environment)
 * - MCP Transport settings (host, port, transport mode)
 * - Security settings (DNS rebinding protection, rate limiting)
 * - Logging configuration
 * - OpenTelemetry settings
 */
export const frameworkEnvSchema = z
  .object({
    // ==========================================================================
    // Application Metadata
    // ==========================================================================

    /**
     * Application version (resolved at module load).
     *
     * Source of Truth: package.json
     * - Docker: build/VERSION file (baked in during build)
     * - npm run: npm_package_version environment variable
     */
    VERSION: z.string().default(VERSION),

    /** Node environment (development, production, test) */
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    // ==========================================================================
    // MCP Transport Settings
    // ==========================================================================

    /** Host to bind the MCP server to (default: 127.0.0.1) */
    MCP_BIND_HOST: z.string().min(1).default("127.0.0.1"),

    /** Port to listen on (default: 8000) */
    MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8000),

    /** Transport mode: 'stdio' for CLI, 'http' for HTTP, 'https' for HTTPS with TLS (default: http) */
    MCP_TRANSPORT: z.enum(["stdio", "http", "https"]).default("stdio"),

    /**
     * Enable Legacy SSE Transport (deprecated HTTP+SSE from protocol 2024-11-05)
     * Default: false (only Streamable HTTP Transport enabled)
     * Set to 'true' to enable backwards compatibility with older MCP clients
     */
    MCP_LEGACY_SSE_ENABLED: booleanFromEnv(false),

    /**
     * Operate in stateless mode (no session IDs).
     *
     * Each request gets a fresh McpSession and SDK transport.
     * No Mcp-Session-Id headers are set. GET and DELETE return 405.
     *
     * @default false (stateful mode)
     */
    MCP_STATELESS: booleanFromEnv(false),

    /**
     * Prefer JSON responses over SSE streams for simple request-response.
     *
     * When enabled, the SDK returns `application/json` for non-streaming
     * responses (e.g. tools/list, resources/list) instead of wrapping them
     * in a `text/event-stream` SSE envelope.
     *
     * **Warning**: JSON mode silently drops all in-flight notifications
     * (progress, logging) because the SDK response stream has no SSE
     * controller. Only the final tool result reaches the client.
     * Enable only if your server never sends progress or log notifications.
     *
     * @default false (SSE streaming — supports progress and notifications)
     */
    MCP_JSON_RESPONSE: booleanFromEnv(false),

    // ==========================================================================
    // TLS Configuration (HTTPS mode)
    // ==========================================================================

    /** Path to TLS certificate file (PEM format). Required when MCP_TRANSPORT='https'. */
    MCP_TLS_CERT_PATH: z.string().min(1).optional(),

    /** Path to TLS private key file (PEM format). Required when MCP_TRANSPORT='https'. */
    MCP_TLS_KEY_PATH: z.string().min(1).optional(),

    /** Path to CA certificate file (PEM format). Optional for custom CA chains. */
    MCP_TLS_CA_PATH: z.string().min(1).optional(),

    // ==========================================================================
    // Security Settings
    // ==========================================================================

    /** Allowed hosts for DNS rebinding protection (comma-separated) */
    MCP_ALLOWED_HOSTS: optionalCommaSeparatedList(),

    /** Rate limit window duration (default: '15m' = 900000ms). Accepts human-readable durations like '15m', '1h', '30s'. */
    MCP_RATE_LIMIT_WINDOW_MS: durationSchema("15m").pipe(z.number().int().min(1000)),

    /** Maximum requests per rate limit window (default: 1000) */
    MCP_RATE_LIMIT_MAX: z.coerce.number().int().min(100).default(1000),

    /**
     * Maximum request body size for `express.json()` middleware.
     *
     * Accepts Express size strings (e.g. `'1mb'`, `'500kb'`, `'2mb'`)
     * or plain byte counts (e.g. `'1048576'`).
     *
     * Validated against the `bytes` library format used by Express/body-parser.
     * Invalid values are rejected at config time to prevent silent limit bypass.
     *
     * @default '1mb'
     */
    MCP_BODY_SIZE_LIMIT: z
      .string()
      .regex(
        BYTE_SIZE_REGEX,
        'Invalid body size format. Use formats like "1mb", "500kb", "2gb", or a plain byte count like "1048576".',
      )
      .default("1mb"),

    /**
     * Trust proxy setting for Express.
     *
     * Required when running behind a reverse proxy (nginx, Traefik, cloud LB)
     * to correctly resolve client IPs, protocol, and host from proxy headers
     * (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`).
     *
     * Values:
     * - Hop count (`'1'`, `'2'`) — Trust N hops from the front-facing proxy
     * - Express keyword (`'loopback'`, `'linklocal'`, `'uniquelocal'`)
     * - IP address (`'10.0.0.1'`, `'::1'`)
     * - CIDR range (`'10.0.0.0/8'`, `'172.16.0.0/12'`)
     * - DNS hostname (`'proxy.example.com'`) — resolved at startup
     * - Comma-separated list (`'loopback, 10.0.0.1'`)
     *
     * Omit or leave unset to disable trust proxy.
     *
     * @see https://expressjs.com/en/guide/behind-proxies.html
     */
    MCP_TRUST_PROXY: z.string().min(1).optional(),

    /**
     * CORS allowed origins (comma-separated).
     *
     * When set, the CORS middleware is mounted globally and allows requests
     * from the listed origins. When unset, CORS is disabled (no CORS headers).
     *
     * Use `'*'` to allow all origins (not recommended for production).
     *
     * @example 'https://app.example.com,https://admin.example.com'
     */
    MCP_CORS_ORIGIN: optionalCommaSeparatedList(),

    /**
     * Allow credentials in CORS requests (cookies, auth headers).
     *
     * Only effective when MCP_CORS_ORIGIN is set.
     * Cannot be used with `origin: '*'`.
     *
     * @default false
     */
    MCP_CORS_CREDENTIALS: booleanFromEnv(false),

    /**
     * Enable HTTP Strict Transport Security (HSTS) header.
     *
     * When true, Helmet sets `Strict-Transport-Security` with `max-age=15552000`
     * (180 days) and `includeSubDomains`. Only enable when serving over HTTPS.
     *
     * @default false (managed by reverse proxy in production)
     */
    MCP_HELMET_HSTS: booleanFromEnv(false),

    /**
     * Content Security Policy configuration.
     *
     * - Omit or leave unset: Helmet default CSP applies
     * - `'false'`: Disable CSP entirely
     * - Custom string: Used as CSP directives (e.g. `"default-src 'self'"`).
     *   Parsed as directive-name + values separated by semicolons.
     */
    MCP_HELMET_CSP: z.string().min(1).optional(),

    /**
     * X-Frame-Options header value.
     *
     * Controls whether the server can be embedded in frames.
     * - `'DENY'`: Never allow framing (most secure)
     * - `'SAMEORIGIN'`: Allow framing from same origin
     * - `'false'`: Disable X-Frame-Options header
     *
     * @default 'DENY'
     */
    MCP_HELMET_FRAME_OPTIONS: z.enum(["DENY", "SAMEORIGIN", "false"]).default("DENY"),

    // ==========================================================================
    // Authentication
    // ==========================================================================

    /**
     * Required OAuth scopes for the `/mcp` endpoint (comma-separated).
     *
     * When set, all requests to `/mcp` must carry tokens with these scopes.
     * Per-tool scopes can be configured via `ToolDefinition.auth.requiredScopes`.
     *
     * @example 'mcp:read,mcp:write'
     */
    MCP_AUTH_REQUIRED_SCOPES: optionalCommaSeparatedList(),

    /**
     * Protected Resource Metadata URL (RFC 9728).
     *
     * When set, included in `WWW-Authenticate` headers for 401 responses,
     * allowing clients to discover the authorization server.
     *
     * @example 'https://api.example.com/.well-known/oauth-protected-resource'
     */
    MCP_AUTH_RESOURCE_METADATA_URL: z.string().url().optional(),

    // ==========================================================================
    // Session Management
    // ==========================================================================

    /** Maximum total concurrent sessions across all transports (default: 200) */
    MCP_MAX_SESSIONS: z.coerce.number().int().min(1).default(200),

    /** Maximum concurrent Streamable HTTP sessions (default: 200) */
    MCP_MAX_STREAMABLE_HTTP_SESSIONS: z.coerce.number().int().min(1).default(200),

    /** Maximum concurrent SSE sessions (default: 50) */
    MCP_MAX_SSE_SESSIONS: z.coerce.number().int().min(1).default(50),

    // ==========================================================================
    // Logging Configuration
    // ==========================================================================

    /** Log level (trace, debug, info, warn, error) */
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

    /** Log format (text, json) */
    LOG_FORMAT: z.enum(["text", "json"]).default("text"),

    /** Include RFC 3339 timestamps in text log output (default: false) */
    LOG_TIMESTAMP: booleanFromEnv(false),

    /** Include component name (e.g. [server-runtime]) in text log output (default: false) */
    LOG_COMPONENT: booleanFromEnv(false),

    /** Directory to store logs (optional) */
    LOG_DIR: z.string().min(1).optional(),

    /**
     * Maximum size of a single log file before rotation.
     *
     * Accepts human-readable size strings (e.g. `'10mb'`, `'500kb'`, `'1gb'`)
     * or plain byte counts (e.g. `'1048576'`). Parsed to bytes at config time.
     *
     * @default '10mb'
     */
    LOG_MAX_FILE_SIZE: byteSizeSchema("10mb").pipe(z.number().int().min(1024)),

    /** Maximum number of rotated log files to keep (default: 3) */
    LOG_MAX_FILES: z.coerce.number().int().min(1).max(100).default(3),

    /** Log file retention in days. Files older than this are deleted. 0 = disabled (default: 0) */
    LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),

    // ==========================================================================
    // OpenTelemetry Configuration
    //
    // Standard OTEL env vars are parsed here so they can also be set via
    // the config file. The SDK and exporters would read these from process.env
    // natively, but routing them through the config system ensures a single
    // source of truth and enables config-file-based setup.
    // See: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
    // ==========================================================================

    /** Enable OpenTelemetry (default: false). Master toggle for all OTEL features. */
    OTEL_ENABLED: booleanFromEnv(false),

    /**
     * OpenTelemetry service name.
     *
     * When not set, defaults to the MCP server name from `createServer({ name })`.
     * Can be overridden via env var or config file to distinguish deployments
     * (e.g. 'app-mcp-prod' vs 'app-mcp-staging').
     *
     * Also read natively by the SDK's resource detector via OTEL_SERVICE_NAME.
     */
    OTEL_SERVICE_NAME: z.string().min(1).optional(),

    /**
     * OTLP exporter endpoint URL (e.g. http://localhost:4318).
     *
     * Used by both trace and metric OTLP exporters.
     * Standard OTEL env var — also read natively by exporters,
     * but parsed here to enable config file support.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

    /**
     * Trace exporter selection.
     *
     * Standard OTEL env var. When set, the framework builds the
     * trace exporter explicitly instead of leaving it to SDK auto-config.
     * Supported: 'otlp' , 'console', 'none' (default).
     */
    OTEL_TRACES_EXPORTER: z.string().min(1).optional(),

    /**
     * Log exporter selection.
     *
     * Standard OTEL env var. Controls whether the NodeSDK auto-configures
     * an OTLP log exporter. The framework uses its own logging system
     * (see {@link Logger | framework logger}), so OTEL log export is disabled
     * by default to prevent unwanted OTLP connections.
     *
     * Supported: 'otlp', 'console', 'none' (default).
     */
    OTEL_LOGS_EXPORTER: z.string().default("none"),

    /**
     * SDK diagnostic log level.
     *
     * Standard OTEL env var. Activates diag logging on the OTEL SDK.
     * Values: 'none', 'error', 'warn', 'info', 'debug', 'verbose', 'all'.
     */
    OTEL_LOG_LEVEL: z.string().min(1).max(7).optional().default("none"),

    /**
     * Periodic metric export interval.
     *
     * Standard OTEL env var name. Controls how often PeriodicExportingMetricReader
     * pushes metrics to the OTLP endpoint or console.
     * Accepts human-readable durations like '60s', '5m', or plain millisecond counts.
     */
    OTEL_METRIC_EXPORT_INTERVAL: z
      .string()
      .transform((val) => parseDuration(val))
      .pipe(z.number().int().positive())
      .optional(),

    /**
     * Metric exporters to activate (comma-separated).
     *
     * Standard OTEL env var name. Supported values:
     * - `otlp` — Push metrics to OTLP endpoint (reads OTEL_EXPORTER_OTLP_ENDPOINT natively)
     * - `prometheus` — Prometheus scrape endpoint at /metrics on the MCP server
     * - `console` — Log metrics to console (useful for debugging)
     * - `none` — Disable all metric export
     *
     * Default: 'prometheus' (Prometheus scrape endpoint)
     */
    OTEL_METRICS_EXPORTER: commaSeparatedList({ lowercase: true }).default("prometheus"),
  })
  .superRefine((data, ctx) => {
    // Validate TLS configuration when HTTPS mode is selected
    // Delegates to the shared constraint validator so the same rules
    // apply regardless of config source (env, file, programmatic).
    const violations = validateConfigConstraints(data);
    for (const violation of violations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: violation.message,
        path: [...violation.path],
      });
    }
  });

// ============================================================================
// Cross-Field Validation
// ============================================================================

/**
 * Constraint violation from cross-field validation.
 */
export interface ConfigConstraintViolation {
  readonly message: string;
  readonly path: readonly string[];
}

/**
 * Validate cross-field constraints on the framework configuration.
 *
 * Extracted as a standalone function so it can be called:
 * 1. By the Zod schema's `superRefine` (env-only parsing)
 * 2. By the config cache after merging all sources (env + file + overrides)
 *
 * @param config - The (potentially merged) configuration to validate
 * @returns Array of constraint violations (empty = valid)
 */
export function validateConfigConstraints(
  config: Pick<
    FrameworkEnvConfig,
    | "MCP_TRANSPORT"
    | "MCP_TLS_CERT_PATH"
    | "MCP_TLS_KEY_PATH"
    | "MCP_TLS_CA_PATH"
    | "MCP_MAX_SESSIONS"
    | "MCP_MAX_STREAMABLE_HTTP_SESSIONS"
    | "MCP_MAX_SSE_SESSIONS"
  >,
): ConfigConstraintViolation[] {
  const violations: ConfigConstraintViolation[] = [];

  // TLS constraint: HTTPS requires both cert and key paths
  if (config.MCP_TRANSPORT === "https") {
    if (!config.MCP_TLS_CERT_PATH) {
      violations.push({
        message: 'MCP_TLS_CERT_PATH is required when MCP_TRANSPORT is "https"',
        path: ["MCP_TLS_CERT_PATH"],
      });
    }
    if (!config.MCP_TLS_KEY_PATH) {
      violations.push({
        message: 'MCP_TLS_KEY_PATH is required when MCP_TRANSPORT is "https"',
        path: ["MCP_TLS_KEY_PATH"],
      });
    }

    // Validate TLS file existence and readability when paths are provided
    if (config.MCP_TLS_CERT_PATH) {
      try {
        accessSync(config.MCP_TLS_CERT_PATH, fsConstants.R_OK);
      } catch {
        violations.push({
          message: `TLS certificate file not found or not readable: ${config.MCP_TLS_CERT_PATH}`,
          path: ["MCP_TLS_CERT_PATH"],
        });
      }
    }
    if (config.MCP_TLS_KEY_PATH) {
      try {
        accessSync(config.MCP_TLS_KEY_PATH, fsConstants.R_OK);
      } catch {
        violations.push({
          message: `TLS private key file not found or not readable: ${config.MCP_TLS_KEY_PATH}`,
          path: ["MCP_TLS_KEY_PATH"],
        });
      }
    }
    if (config.MCP_TLS_CA_PATH) {
      try {
        accessSync(config.MCP_TLS_CA_PATH, fsConstants.R_OK);
      } catch {
        violations.push({
          message: `TLS CA certificate file not found or not readable: ${config.MCP_TLS_CA_PATH}`,
          path: ["MCP_TLS_CA_PATH"],
        });
      }
    }
  }

  // Session limits: per-transport caps must not exceed the global cap.
  // Limits are independent — global MCP_MAX_SESSIONS is a first-come-first-served hard cap,
  // while per-transport limits are independent ceilings within that global pool.
  if (config.MCP_MAX_STREAMABLE_HTTP_SESSIONS > config.MCP_MAX_SESSIONS) {
    violations.push({
      message:
        `MCP_MAX_STREAMABLE_HTTP_SESSIONS (${config.MCP_MAX_STREAMABLE_HTTP_SESSIONS}) ` +
        `exceeds MCP_MAX_SESSIONS (${config.MCP_MAX_SESSIONS})`,
      path: ["MCP_MAX_SESSIONS", "MCP_MAX_STREAMABLE_HTTP_SESSIONS"],
    });
  }
  if (config.MCP_MAX_SSE_SESSIONS > config.MCP_MAX_SESSIONS) {
    violations.push({
      message:
        `MCP_MAX_SSE_SESSIONS (${config.MCP_MAX_SSE_SESSIONS}) ` +
        `exceeds MCP_MAX_SESSIONS (${config.MCP_MAX_SESSIONS})`,
      path: ["MCP_MAX_SESSIONS", "MCP_MAX_SSE_SESSIONS"],
    });
  }

  return violations;
}

// ============================================================================
// Type Exports
// ============================================================================

/**
 * Framework environment configuration type.
 */
export type FrameworkEnvConfig = z.infer<typeof frameworkEnvSchema>;

/**
 * Parse and validate an environment source against the framework schema.
 *
 * @param envSource - Key-value object to parse (defaults to `process.env`)
 * @returns Validated framework configuration
 * @internal Used only by config-cache.ts — consumers should use `getFrameworkConfig()`
 */
export function parseFrameworkEnv(envSource: Record<string, string | undefined> = process.env): FrameworkEnvConfig {
  return frameworkEnvSchema.parse(envSource);
}
