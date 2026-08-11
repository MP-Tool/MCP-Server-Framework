/**
 * Structured Log Schema Module
 *
 * Defines the JSON log format compatible with ELK Stack, Datadog, Splunk,
 * and other log aggregation platforms.
 *
 * Based on:
 * - Elastic Common Schema (ECS) 8.x
 * - OpenTelemetry Semantic Conventions
 * - RFC 5424 Syslog
 *
 * @module logger/formatters/schema
 */

import type { LogLevel } from "../core/types.js";
import { LOG_SEVERITY } from "../core/constants.js";

/**
 * Minimal serialized error interface for log entries.
 * Duck-typed to avoid importing from the errors module.
 * Compatible with AppError.toJSON() output.
 */
interface LogSerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

/**
 * Structured log entry for JSON output.
 * Compatible with ECS (Elastic Common Schema) for log aggregation.
 */
/**
 * ECS version this schema targets.
 * @see https://www.elastic.co/guide/en/ecs/current
 */
export const ECS_VERSION = "8.11.0";

export interface StructuredLogEntry {
  /** ISO 8601 timestamp with milliseconds */
  "@timestamp": string;

  /** ECS schema version (mandatory per ECS specification) */
  "ecs.version": string;

  /** Log level (uppercase for ECS compatibility) */
  level: Uppercase<LogLevel>;

  /** Log level as numeric severity (RFC 5424: 0=Emergency, 7=Debug) */
  "log.level": number;

  /** Logger name / component that produced this entry */
  "log.logger"?: string | undefined;

  /** Human-readable log message */
  message: string;

  /** Service identification */
  service: {
    /** Service name (e.g., 'mcp-server') */
    name: string;
    /** Service version */
    version?: string | undefined;
    /** Environment (development, production, test) */
    environment?: string | undefined;
    /** Component within the service */
    component?: string | undefined;
  };

  /** Host information */
  host?:
    | {
        /** Hostname */
        name?: string | undefined;
        /** CPU architecture (e.g., 'x64', 'arm64') */
        architecture?: string | undefined;
        /** Operating system information */
        os?:
          | {
              /** OS type / platform (e.g., 'linux', 'darwin', 'win32') */
              type?: string | undefined;
            }
          | undefined;
      }
    | undefined;

  /** Process information */
  process?:
    | {
        /** Process ID */
        pid?: number | undefined;
        /** Process name */
        name?: string | undefined;
      }
    | undefined;

  /** Trace context for distributed tracing */
  trace?:
    | {
        /** Trace ID (W3C Trace Context format) */
        id?: string | undefined;
        /** Span ID */
        "span.id"?: string | undefined;
        /** Parent span ID */
        "parent.id"?: string | undefined;
      }
    | undefined;

  /** Session information */
  session?:
    | {
        /** Session ID */
        id?: string | undefined;
      }
    | undefined;

  /** HTTP request context (if applicable) */
  http?:
    | {
        /** HTTP method */
        method?: string | undefined;
        /** Request URL path */
        "url.path"?: string | undefined;
        /** Response status code */
        "response.status_code"?: number | undefined;
        /** Request duration in milliseconds */
        "request.duration_ms"?: number | undefined;
      }
    | undefined;

  /** Error information (if this is an error log) */
  error?:
    | {
        /** Error type/class name */
        type?: string | undefined;
        /** Error message */
        message?: string | undefined;
        /** Application-specific error code */
        code?: string | undefined;
        /** Stack trace (array of frames) */
        stack_trace?: string | undefined;
      }
    | undefined;

  /** Event metadata */
  event?:
    | {
        /** Event category (e.g., 'tool', 'api', 'transport') */
        category?: string | undefined;
        /** Event action (e.g., 'execute', 'connect', 'disconnect') */
        action?: string | undefined;
        /** Event outcome ('success', 'failure', 'unknown') */
        outcome?: "success" | "failure" | "unknown" | undefined;
        /** Event duration in nanoseconds */
        duration?: number | undefined;
      }
    | undefined;

  /** Labels for custom indexing */
  labels?: Record<string, string | number | boolean> | undefined;

  /** Additional metadata (custom fields) */
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Options for buildLogEntry() factory function.
 */
export interface LogEntryOptions {
  readonly level: LogLevel;
  readonly message: string;
  readonly service?: StructuredLogEntry["service"] | undefined;
  readonly component?: string | undefined;
  readonly host?: StructuredLogEntry["host"] | undefined;
  readonly process?: StructuredLogEntry["process"] | undefined;
  readonly trace?: StructuredLogEntry["trace"] | undefined;
  readonly session?: StructuredLogEntry["session"] | undefined;
  readonly http?: StructuredLogEntry["http"] | undefined;
  readonly error?: (Error | LogSerializedError) | undefined;
  readonly event?: StructuredLogEntry["event"] | undefined;
  readonly labels?: Record<string, string | number | boolean> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Format error for structured log entry.
 */
function formatLogError(error: Error | LogSerializedError): StructuredLogEntry["error"] {
  if ("toJSON" in error && typeof error.toJSON === "function") {
    try {
      // @ts-limitation — Duck-typed toJSON() returns unknown; runtime check validates AppError pattern
      const serialized = error.toJSON() as LogSerializedError;
      return {
        type: serialized.name,
        message: serialized.message,
        code: serialized.code,
        stack_trace: serialized.stack,
      };
    } catch {
      // toJSON() threw — fall through to standard Error handling
    }
  }
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      stack_trace: error.stack,
    };
  }
  return {
    type: error.name,
    message: error.message,
    code: error.code,
    stack_trace: error.stack,
  };
}

/**
 * Build a structured log entry from options.
 *
 * Replaces the fluent LogEntryBuilder with a single-call factory function.
 * All optional fields that are undefined are stripped from the output.
 *
 * @param options - Log entry parameters
 * @returns Clean StructuredLogEntry with only defined fields
 */
export function buildLogEntry(options: LogEntryOptions): StructuredLogEntry {
  const entry: StructuredLogEntry = {
    "@timestamp": new Date().toISOString(),
    "ecs.version": ECS_VERSION,
    // @ts-limitation — String.toUpperCase() returns string; TS cannot infer Uppercase<T> template literal
    level: options.level.toUpperCase() as Uppercase<LogLevel>,
    "log.level": LOG_SEVERITY[options.level],
    message: options.message,
    service: options.service ?? { name: "mcp-server" },
    ...(options.component && { "log.logger": options.component }),
    ...(options.host && { host: options.host }),
    ...(options.process && { process: options.process }),
    ...(options.trace && { trace: options.trace }),
    ...(options.session && { session: options.session }),
    ...(options.http && { http: options.http }),
    ...(options.error && { error: formatLogError(options.error) }),
    ...(options.event && { event: options.event }),
    ...(options.labels && { labels: options.labels }),
    ...(options.metadata &&
      Object.keys(options.metadata).length > 0 && {
        metadata: options.metadata,
      }),
  };
  // Spread conditionals above already exclude undefined top-level fields.
  // Any nested undefined values are naturally stripped by JSON.stringify()
  // in downstream formatters, so no separate round-trip is needed.
  return entry;
}
