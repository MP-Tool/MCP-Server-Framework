/**
 * Config File Schema, Types & Mapper
 *
 * This module is the single source of truth for:
 * - Config file types and constants (formats, discovery filenames, result types)
 * - Zod schemas for config file sections
 * - Mapping between nested config file structure and flat `FrameworkEnvConfig`
 *
 * The schema is **lenient** regarding unknown keys: unrecognized
 * fields are silently stripped during validation. The loader
 * detects stripped keys and emits warnings so typos are visible
 * without crashing the server.
 *
 * All fields are optional — you only configure what you need.
 *
 * Intentionally excluded from config file support:
 * - `MCP_CONFIG_FILE_PATH` — meta-config (chicken-egg problem)
 * - `NODE_ENV` — runtime concern, not file-config
 * - `VERSION` — build/deployment concern
 *
 * @module config/file/schema
 */

import { z } from "zod";
import type { FrameworkEnvConfig } from "../env.js";
import {
  splitCommaSeparated,
  BYTE_SIZE_REGEX,
  parseByteSize,
  parseDuration,
  DURATION_REGEX,
} from "../../utils/string-helpers.js";

// ============================================================================
// Types & Constants
// ============================================================================

/** Supported config file formats */
export type ConfigFileFormat = "toml" | "yaml" | "json";

/**
 * Config file names for auto-discovery (ordered by priority).
 *
 * The first file found in `process.cwd()` wins.
 * TOML is preferred over YAML since it's more explicit for server configuration.
 * JSON has lowest priority since it doesn't support comments.
 */
export const DISCOVERY_FILENAMES = ["config.toml", "config.yaml", "config.yml", "config.json"] as const;

/**
 * Environment variable to explicitly specify a config file path.
 *
 * When set, auto-discovery is skipped and this path is used directly.
 * The file must exist — an explicit path that doesn't resolve is an error.
 *
 * This is a meta-config variable and intentionally NOT part of `FrameworkEnvConfig`.
 */
export const CONFIG_FILE_ENV_VAR = "MCP_CONFIG_FILE_PATH" as const;

/**
 * Maps file extensions to their format.
 *
 * Frozen at runtime to prevent
 * accidental mutation of framework constants.
 */
export const EXTENSION_FORMAT_MAP: Readonly<Record<string, ConfigFileFormat>> = Object.freeze({
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
});

/**
 * Result of loading and parsing a config file.
 *
 * Contains the overrides to apply to `FrameworkEnvConfig` and metadata
 * about the source file (for logging after logger initialization).
 */
export interface ConfigFileResult {
  /** Partial overrides to merge into the framework config */
  readonly overrides: Partial<FrameworkEnvConfig>;
  /** Absolute path to the config file that was loaded */
  readonly sourcePath: string;
  /** Format of the loaded file */
  readonly format: ConfigFileFormat;
  /**
   * The parsed `[auth]` section, retained verbatim because its nested `providers`
   * table cannot be flattened into the env-style `overrides`. Consumed by
   * `resolveAuthConfig()`. `undefined` when the file has no `[auth]` section.
   */
  readonly rawAuth?: AuthSectionData | undefined;
}

// ============================================================================
// Section Schemas
// ============================================================================

const transportSection = z
  .object({
    /** Transport mode: 'stdio', 'http', or 'https' */
    mode: z.enum(["stdio", "http", "https"]),
    /** Port to listen on */
    port: z.number().int().min(1).max(65535),
    /** Host to bind to */
    host: z.string().min(1),
    /** Public base URL behind a proxy/domain (e.g. 'https://mcp.example.com'). Env: MCP_BASE_URL */
    base_url: z.string().url(),
    /** Enable SSE transport (legacy protocol 2024-11-05) */
    sse_enabled: z.boolean(),
    /** Operate in stateless mode (no session IDs) */
    stateless: z.boolean(),
    /** Prefer JSON responses over SSE for simple request-response (default: false) */
    json_response: z.boolean(),
    /** TLS configuration (required when mode is 'https') */
    tls: z
      .object({
        /** Path to TLS certificate file (PEM) */
        cert_path: z.string().min(1),
        /** Path to TLS private key file (PEM) */
        key_path: z.string().min(1),
        /** Path to CA certificate file (PEM, optional) */
        ca_path: z.string().min(1),
      })
      .partial()
      .optional(),
  })
  .partial();

const securitySection = z
  .object({
    /** Allowed hosts for DNS rebinding protection */
    allowed_hosts: z.array(z.string().min(1)),
    /** Maximum requests per rate limit window */
    rate_limit_max: z.number().int().min(100),
    /** Rate limit window as duration (e.g. '15m', '1h') or milliseconds (number) */
    rate_limit_window: z.union([z.number().int().min(1000), z.string().regex(DURATION_REGEX)]),
    /**
     * Trust proxy setting for Express.
     * Values: hop count (number ≥ 1), or string (IP/CIDR/keyword/hostname).
     * @see https://expressjs.com/en/guide/behind-proxies.html
     */
    trust_proxy: z.union([z.number().int().min(1), z.string().min(1)]),
    /** CORS allowed origins (array of origin strings). Unset = CORS disabled. */
    cors_origin: z.array(z.string().min(1)),
    /** Allow credentials in CORS requests */
    cors_credentials: z.boolean(),
    /** Enable HSTS header */
    helmet_hsts: z.boolean(),
    /** Content Security Policy: custom string, or 'false' to disable */
    helmet_csp: z.string().min(1),
    /** X-Frame-Options: DENY or SAMEORIGIN */
    helmet_frame_options: z.enum(["DENY", "SAMEORIGIN"]),
    /** Maximum request body size for express.json() (e.g. '1mb', '500kb') */
    body_size_limit: z.string().regex(BYTE_SIZE_REGEX),
  })
  .partial();

const sessionSection = z
  .object({
    /** Maximum total concurrent sessions across all transports */
    max_sessions: z.number().int().min(1),
    /** Maximum concurrent Streamable HTTP sessions */
    max_streamable_http_sessions: z.number().int().min(1),
    /** Maximum concurrent SSE sessions */
    max_sse_sessions: z.number().int().min(1),
  })
  .partial();

const loggingSection = z
  .object({
    /** Log level */
    level: z.enum(["trace", "debug", "info", "warn", "error"]),
    /** Log format */
    format: z.enum(["text", "json"]),
    /** Include RFC 3339 timestamps in text log output */
    timestamp: z.boolean(),
    /** Include component name in text log output */
    component: z.boolean(),
    /** Directory for log files */
    log_dir: z.string().min(1),
    /** Path to a dedicated audit-log file (JSON Lines), parallel to normal logs */
    audit_file: z.string().min(1),
    /** Maximum log file size before rotation (e.g. "10mb", "500kb") */
    max_file_size: z.string().regex(BYTE_SIZE_REGEX),
    /** Maximum number of rotated log files to keep */
    max_files: z.number().int().min(1).max(100),
    /** Log file retention in days. Files older than this are deleted. 0 = disabled. */
    retention_days: z.number().int().min(0),
  })
  .partial();

const telemetrySection = z
  .object({
    /** Enable OpenTelemetry */
    enabled: z.boolean(),
    /** Service name for OTEL */
    service_name: z.string().min(1),
    /** OTLP exporter endpoint URL (e.g. http://localhost:4318) */
    exporter_endpoint: z.string().url(),
    /** Trace exporter: otlp, console, none */
    traces_exporter: z.string().min(1),
    /** Log exporter: otlp, console, none (default: 'none' — framework has its own logger) */
    logs_exporter: z.string().min(1),
    /** SDK diagnostic log level: NONE, ERROR, WARN, INFO, DEBUG, VERBOSE, ALL */
    log_level: z.string().min(1),
    /** Periodic metric export interval as duration (e.g. '60s', '5m') or milliseconds (number) */
    metric_export_interval: z.union([z.number().int().positive(), z.string().regex(DURATION_REGEX)]),
    /**
     * Metric exporters (comma-separated): otlp, prometheus, console, none.
     * Default: 'prometheus'
     */
    metrics_exporter: z.string().min(1),
  })
  .partial();

/**
 * One upstream OAuth provider entry under `[auth.providers.<name>]`.
 *
 * Generic across MCP servers. The table key (e.g. `google`, `github`, `acme`) is the
 * routing name; `type` may be omitted when the key is a known preset. Accepts both the
 * `id`/`secret` aliases (mirroring some IdP configs) and `client_id`/`client_secret`.
 */
const authProviderSection = z
  .object({
    /** Whether this provider is active. Defaults to true when omitted. */
    enabled: z.boolean(),
    /** Provider kind. Inferred from the table key when omitted (`google`/`github` presets, else `oidc`). */
    type: z.enum(["google", "github", "oidc"]),
    /** OAuth client ID (alias of `client_id`). */
    id: z.string().min(1),
    /** OAuth client ID. */
    client_id: z.string().min(1),
    /** OAuth client secret (alias of `secret`). */
    client_secret: z.string().min(1),
    /** OAuth client secret. */
    secret: z.string().min(1),
    /** OIDC issuer URL (required for `oidc`; optional override for `google`). */
    issuer: z.string().url(),
    /** Requested upstream scopes. */
    scopes: z.array(z.string().min(1)),
  })
  .partial();

const authSection = z
  .object({
    /** Master switch for MCP-server user authentication. */
    enabled: z.boolean(),
    /** Upstream OAuth providers, keyed by routing name (`[auth.providers.<name>]`). */
    providers: z.record(z.string(), authProviderSection),
    /** Required OAuth scopes for the /mcp endpoint (array of scope strings) */
    required_scopes: z.array(z.string().min(1)),
  })
  .partial();

/** Parsed `[auth]` section, retained for {@link ConfigFileResult.rawAuth}. */
export type AuthSectionData = z.infer<typeof authSection>;

// ============================================================================
// Root Schema
// ============================================================================

/**
 * Map of section names to their Zod schemas.
 *
 * Used by the loader to derive known section names and keys
 * instead of maintaining a manual duplicate list.
 *
 * Also the single source of truth for `configFileSchema` — the root
 * schema is derived from this map via `z.object(…).partial()`.
 *
 * @internal
 */
export const CONFIG_FILE_SECTIONS = Object.freeze({
  transport: transportSection,
  security: securitySection,
  session: sessionSection,
  logging: loggingSection,
  telemetry: telemetrySection,
  auth: authSection,
}) satisfies Readonly<Record<string, z.ZodTypeAny>>;

/**
 * Config file root schema.
 *
 * Nested, section-based structure that maps to `FrameworkEnvConfig`.
 * `.strict()` is intentionally NOT used — unknown keys are stripped
 * during parsing and surfaced as warnings by the loader, so typos
 * are visible but don't prevent the server from starting.
 *
 * Derived from `CONFIG_FILE_SECTIONS` to avoid duplicate
 * section listings (DRY).
 *
 * @example TOML
 * ```toml
 * [transport]
 * mode = "http"
 * port = 3000
 *
 * [logging]
 * level = "debug"
 * format = "json"
 * ```
 *
 * @example YAML
 * ```yaml
 * transport:
 *   mode: http
 *   port: 3000
 * logging:
 *   level: debug
 * ```
 */
export const configFileSchema = z.object(CONFIG_FILE_SECTIONS).partial();

/** Validated config file type */
export type ConfigFileData = z.infer<typeof configFileSchema>;

// ============================================================================
// Mapper
// ============================================================================

/**
 * Map validated config file data to `FrameworkEnvConfig` overrides.
 *
 * Only explicitly defined values become overrides — `undefined` fields
 * are omitted so they don't clobber environment-based defaults.
 *
 * The mapping is flat and explicit: each config file key maps to exactly
 * one `FrameworkEnvConfig` key. No implicit behavior, no magic.
 *
 * @param config - Validated config file data
 * @returns Partial overrides for `FrameworkEnvConfig`
 */
export function mapConfigToOverrides(config: ConfigFileData): Partial<FrameworkEnvConfig> {
  const overrides: Partial<FrameworkEnvConfig> = {};

  // ── Transport ──────────────────────────────────────────────────────────
  if (config.transport) {
    const t = config.transport;
    if (t.mode !== undefined) overrides.MCP_TRANSPORT = t.mode;
    if (t.port !== undefined) overrides.MCP_PORT = t.port;
    if (t.host !== undefined) overrides.MCP_BIND_HOST = t.host;
    if (t.base_url !== undefined) overrides.MCP_BASE_URL = t.base_url;
    if (t.sse_enabled !== undefined) overrides.MCP_LEGACY_SSE_ENABLED = t.sse_enabled;
    if (t.stateless !== undefined) overrides.MCP_STATELESS = t.stateless;
    if (t.json_response !== undefined) overrides.MCP_JSON_RESPONSE = t.json_response;

    if (t.tls) {
      if (t.tls.cert_path !== undefined) overrides.MCP_TLS_CERT_PATH = t.tls.cert_path;
      if (t.tls.key_path !== undefined) overrides.MCP_TLS_KEY_PATH = t.tls.key_path;
      if (t.tls.ca_path !== undefined) overrides.MCP_TLS_CA_PATH = t.tls.ca_path;
    }
  }

  // ── Security ───────────────────────────────────────────────────────────
  if (config.security) {
    const s = config.security;
    if (s.allowed_hosts !== undefined) overrides.MCP_ALLOWED_HOSTS = s.allowed_hosts;
    if (s.rate_limit_max !== undefined) overrides.MCP_RATE_LIMIT_MAX = s.rate_limit_max;
    if (s.rate_limit_window !== undefined)
      overrides.MCP_RATE_LIMIT_WINDOW_MS = parseDuration(String(s.rate_limit_window));
    if (s.trust_proxy !== undefined) overrides.MCP_TRUST_PROXY = String(s.trust_proxy);
    if (s.cors_origin !== undefined) overrides.MCP_CORS_ORIGIN = s.cors_origin;
    if (s.cors_credentials !== undefined) overrides.MCP_CORS_CREDENTIALS = s.cors_credentials;
    if (s.helmet_hsts !== undefined) overrides.MCP_HELMET_HSTS = s.helmet_hsts;
    if (s.helmet_csp !== undefined) overrides.MCP_HELMET_CSP = s.helmet_csp;
    if (s.helmet_frame_options !== undefined) overrides.MCP_HELMET_FRAME_OPTIONS = s.helmet_frame_options;
    if (s.body_size_limit !== undefined) overrides.MCP_BODY_SIZE_LIMIT = s.body_size_limit;
  }

  // ── Session ────────────────────────────────────────────────────────────
  if (config.session) {
    const sess = config.session;
    if (sess.max_sessions !== undefined) overrides.MCP_MAX_SESSIONS = sess.max_sessions;
    if (sess.max_streamable_http_sessions !== undefined)
      overrides.MCP_MAX_STREAMABLE_HTTP_SESSIONS = sess.max_streamable_http_sessions;
    if (sess.max_sse_sessions !== undefined) overrides.MCP_MAX_SSE_SESSIONS = sess.max_sse_sessions;
  }

  // ── Logging ────────────────────────────────────────────────────────────
  if (config.logging) {
    const l = config.logging;
    if (l.level !== undefined) overrides.LOG_LEVEL = l.level;
    if (l.format !== undefined) overrides.LOG_FORMAT = l.format;
    if (l.timestamp !== undefined) overrides.LOG_TIMESTAMP = l.timestamp;
    if (l.component !== undefined) overrides.LOG_COMPONENT = l.component;
    if (l.log_dir !== undefined) overrides.LOG_DIR = l.log_dir;
    if (l.audit_file !== undefined) overrides.MCP_AUDIT_FILE = l.audit_file;
    if (l.max_file_size !== undefined) overrides.LOG_MAX_FILE_SIZE = parseByteSize(l.max_file_size);
    if (l.max_files !== undefined) overrides.LOG_MAX_FILES = l.max_files;
    if (l.retention_days !== undefined) overrides.LOG_RETENTION_DAYS = l.retention_days;
  }

  // ── Telemetry ──────────────────────────────────────────────────────────
  if (config.telemetry) {
    const o = config.telemetry;
    if (o.enabled !== undefined) overrides.OTEL_ENABLED = o.enabled;
    if (o.service_name !== undefined) overrides.OTEL_SERVICE_NAME = o.service_name;
    if (o.exporter_endpoint !== undefined) overrides.OTEL_EXPORTER_OTLP_ENDPOINT = o.exporter_endpoint;
    if (o.traces_exporter !== undefined) overrides.OTEL_TRACES_EXPORTER = o.traces_exporter;
    if (o.logs_exporter !== undefined) overrides.OTEL_LOGS_EXPORTER = o.logs_exporter;
    if (o.log_level !== undefined) overrides.OTEL_LOG_LEVEL = o.log_level;
    if (o.metric_export_interval !== undefined)
      overrides.OTEL_METRIC_EXPORT_INTERVAL = parseDuration(String(o.metric_export_interval));
    if (o.metrics_exporter !== undefined) {
      // Config file stores single string, env.ts expects string[] after transform
      overrides.OTEL_METRICS_EXPORTER = splitCommaSeparated(o.metrics_exporter, { lowercase: true });
    }
  }

  // ── Auth ───────────────────────────────────────────────────────────────
  if (config.auth) {
    const a = config.auth;
    if (a.required_scopes !== undefined) overrides.MCP_AUTH_REQUIRED_SCOPES = a.required_scopes;
  }

  return overrides;
}

// ============================================================================
// Reverse Mapper (Typed → String Env Keys)
// ============================================================================

/**
 * Serialize typed config overrides back to string key-value pairs.
 *
 * This is the reverse of what Zod coercion does. It converts typed
 * `Partial<FrameworkEnvConfig>` values back to the string format that
 * `parseFrameworkEnv()` expects, so config-file values can be merged
 * into the env source dict alongside `.env` and `process.env` entries.
 *
 * Used by `initializeConfig()` to implement 12-Factor priority:
 * `{ ...dotenvValues, ...mapConfigToEnvKeys(fileOverrides), ...process.env }`
 *
 * @param overrides - Typed config overrides from `mapConfigToOverrides()`
 * @returns String key-value pairs suitable for Zod env parsing
 */
export function mapConfigToEnvKeys(overrides: Partial<FrameworkEnvConfig>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      // string[] → comma-separated string (e.g., OTEL_METRICS_EXPORTER)
      result[key] = value.join(",");
    } else {
      // string | number | boolean → String()
      result[key] = String(value);
    }
  }

  return result;
}
