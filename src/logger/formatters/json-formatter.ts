/**
 * JSON Formatter Module
 *
 * Provides structured JSON log formatting compatible with ELK Stack,
 * Datadog, Splunk, and other log aggregation platforms.
 *
 * @module logger/formatters/json-formatter
 */

import type { LogFormatter, LogEntryParams } from "../core/types.js";
import { buildLogEntry } from "./schema.js";

/**
 * Configuration for the JSON formatter.
 */
export interface JsonFormatterConfig {
  /** Service name for structured logs */
  serviceName: string;
  /** Service version */
  serviceVersion: string;
  /** Environment (e.g., 'development', 'production') */
  environment: string;
  /** Whether to pretty-print JSON (default: false) */
  prettyPrint?: boolean;
  /** Hostname (computed once at init) */
  hostname?: string;
  /** CPU architecture (e.g., 'x64', 'arm64') */
  architecture?: string;
  /** OS type / platform (e.g., 'linux', 'darwin') */
  osType?: string;
  /** Process ID */
  pid?: number;
  /** Process name */
  processName?: string;
}

/**
 * JSON Formatter class for structured log output.
 *
 * Produces ECS-compatible JSON logs suitable for log aggregation platforms.
 */
export class JsonFormatter implements LogFormatter {
  private config: JsonFormatterConfig;
  private prettyPrint: boolean;

  /**
   * Create a new JsonFormatter.
   * @param config - Formatter configuration
   */
  constructor(config: JsonFormatterConfig) {
    this.config = config;
    this.prettyPrint = config.prettyPrint ?? false;
  }

  /**
   * Format a log entry as JSON.
   *
   * @param params - Log entry parameters
   * @returns JSON string
   */
  public format(params: LogEntryParams): string {
    const { level, message, component, context, metadata } = params;

    const entry = buildLogEntry({
      level,
      message,
      service: {
        name: this.config.serviceName,
        version: this.config.serviceVersion,
        environment: this.config.environment,
        component,
      },
      host:
        this.config.hostname || this.config.architecture || this.config.osType
          ? {
              name: this.config.hostname,
              architecture: this.config.architecture,
              os: this.config.osType ? { type: this.config.osType } : undefined,
            }
          : undefined,
      process:
        this.config.pid !== undefined || this.config.processName
          ? { pid: this.config.pid, name: this.config.processName }
          : undefined,
      trace: context?.traceId || context?.spanId ? { id: context?.traceId, "span.id": context?.spanId } : undefined,
      session: context?.sessionId ? { id: context.sessionId } : undefined,
      http: context?.http
        ? {
            method: context.http.method,
            "url.path": context.http.path,
            "response.status_code": context.http.statusCode,
            "request.duration_ms": context.http.durationMs,
          }
        : undefined,
      event: context?.event
        ? {
            category: context.event.category,
            action: context.event.action,
            outcome: context.event.outcome,
          }
        : undefined,
      error: params.error,
      metadata,
      labels: context?.requestId ? { request_id: context.requestId } : undefined,
    });

    if (this.prettyPrint) {
      return JSON.stringify(entry, null, 2);
    }

    return JSON.stringify(entry);
  }
}
