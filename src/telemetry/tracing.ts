/**
 * OpenTelemetry Tracing Utilities
 *
 * Provides convenient helpers for creating and managing spans.
 * All OTEL imports are lazy-loaded (see DD-020). Synchronous functions
 * gracefully no-op when the API hasn't been loaded yet.
 *
 * @module server/telemetry/tracing
 */

import type { Span, Attributes, Tracer } from "@opentelemetry/api";
import {
  getTelemetryConfig,
  type SpanOptions,
  type TraceContext,
  type SpanCallback,
  type AsyncSpanCallback,
} from "./core/index.js";

// ============================================================================
// Lazy-loaded @opentelemetry/api cache
// ============================================================================

/** Cached references to the @opentelemetry/api value exports */
interface OtelApi {
  trace: typeof import("@opentelemetry/api").trace;
  context: typeof import("@opentelemetry/api").context;
  SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
  SpanKind: typeof import("@opentelemetry/api").SpanKind;
}

let otelApi: OtelApi | null = null;

/**
 * Lazily load and cache the @opentelemetry/api value exports.
 * Called on every async path; returns instantly after first load.
 */
async function loadOtelApi(): Promise<OtelApi> {
  if (otelApi) return otelApi;
  const api = await import("@opentelemetry/api");
  otelApi = {
    trace: api.trace,
    context: api.context,
    SpanStatusCode: api.SpanStatusCode,
    SpanKind: api.SpanKind,
  };
  return otelApi;
}

/**
 * Synchronous access to the cached API. Returns null when the module
 * hasn't been loaded yet — callers must handle the noop path.
 */
function getCachedOtelApi(): OtelApi | null {
  return otelApi;
}

// ============================================================================
// Framework-level SpanKind / SpanStatusCode constants
// ============================================================================
// These mirror the OTEL enum values so that consumers can import them from
// the framework without triggering a static @opentelemetry/api import.
// They are numeric-compatible with the OTEL enums.

/** @public SpanKind constants — numeric-compatible with `@opentelemetry/api.SpanKind` */
export const FrameworkSpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const;

/** @public SpanStatusCode constants — numeric-compatible with `@opentelemetry/api.SpanStatusCode` */
export const FrameworkSpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

/**
 * Get the tracer instance for the MCP Server.
 * Returns a noop tracer proxy when the OTEL API hasn't been loaded yet.
 */
export function getTracer(): Tracer {
  const tracer = getTracerOrNull();
  if (tracer) return tracer;
  // Return a minimal noop tracer when OTEL API isn't loaded yet.
  // All methods are safe to call — spans are discarded.
  return {
    startSpan: () => noopSpan,
    startActiveSpan: (_name: string, ...args: unknown[]) => {
      // startActiveSpan has multiple overloads; the last arg is always the callback
      const fn = args[args.length - 1] as (span: Span) => unknown;
      return fn(noopSpan);
    },
    // @ts-limitation — object literal satisfies Tracer contract but TS cannot infer structural compatibility
  } as Tracer;
}

/** Minimal noop span for the noop tracer fallback */
const noopSpan: Span = {
  spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  addLink: () => noopSpan,
  addLinks: () => noopSpan,
  setStatus: () => noopSpan,
  updateName: () => noopSpan,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
  // @ts-limitation — object literal satisfies Span contract but TS cannot infer structural compatibility
} as Span;

/**
 * Get the tracer instance for the MCP Server.
 * Returns undefined when the OTEL API hasn't been loaded yet.
 * @internal
 */
function getTracerOrNull(): Tracer | undefined {
  const api = getCachedOtelApi();
  if (!api) return undefined;
  const config = getTelemetryConfig();
  return api.trace.getTracer(config.serviceName, config.serviceVersion);
}

/**
 * Get the tracer instance (async — loads OTEL API if needed).
 */
async function getTracerAsync(): Promise<Tracer> {
  const api = await loadOtelApi();
  const config = getTelemetryConfig();
  return api.trace.getTracer(config.serviceName, config.serviceVersion);
}

/**
 * Execute a function within a new span.
 * Automatically handles errors and sets span status.
 *
 * @param name - Name of the span
 * @param fn - Function to execute within the span
 * @param options - Span options
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * const result = await withSpan('processRequest', async (span) => {
 *   span.setAttribute('request.id', requestId);
 *   return await processRequest();
 * });
 * ```
 */
export async function withSpan<T>(name: string, fn: AsyncSpanCallback<T>, options: SpanOptions = {}): Promise<T> {
  const api = await loadOtelApi();
  const tracer = await getTracerAsync();
  const parentContext = options.parentContext ?? api.context.active();

  return tracer.startActiveSpan(
    name,
    {
      kind: options.kind ?? api.SpanKind.INTERNAL,
      ...(options.attributes !== undefined && {
        attributes: options.attributes,
      }),
    },
    parentContext,
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: api.SpanStatusCode.OK });
        return result;
      } catch (error) {
        // Record the error on the span
        if (error instanceof Error) {
          span.recordException(error);
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: error.message,
          });
        } else {
          span.setStatus({
            code: api.SpanStatusCode.ERROR,
            message: String(error),
          });
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Execute a synchronous function within a new span.
 *
 * @param name - Name of the span
 * @param fn - Function to execute within the span
 * @param options - Span options
 * @returns The result of the function
 */
export function withSpanSync<T>(name: string, fn: SpanCallback<T>, options: SpanOptions = {}): T {
  const api = getCachedOtelApi();
  const tracer = getTracerOrNull();

  // When OTEL hasn't been loaded yet, run fn without tracing
  if (!api || !tracer) {
    return fn(noopSpan);
  }

  const parentContext = options.parentContext ?? api.context.active();

  const span = tracer.startSpan(
    name,
    {
      kind: options.kind ?? api.SpanKind.INTERNAL,
      ...(options.attributes !== undefined && {
        attributes: options.attributes,
      }),
    },
    parentContext,
  );

  try {
    const ctx = api.trace.setSpan(parentContext, span);
    const result = api.context.with(ctx, () => fn(span));
    span.setStatus({ code: api.SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (error instanceof Error) {
      span.recordException(error);
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: error.message,
      });
    } else {
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: String(error),
      });
    }
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Get the currently active span.
 * Returns undefined if no span is active or OTEL API is not loaded.
 */
export function getActiveSpan(): Span | undefined {
  const api = getCachedOtelApi();
  if (!api) return undefined;
  return api.trace.getActiveSpan();
}

/**
 * Add attributes to the active span.
 * Does nothing if no span is active.
 */
export function addSpanAttributes(attributes: Attributes): void {
  const span = getActiveSpan();
  if (span) {
    span.setAttributes(attributes);
  }
}

/**
 * Add an event to the active span.
 * Does nothing if no span is active.
 */
export function addSpanEvent(name: string, attributes?: Attributes): void {
  const span = getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Get the current trace context for propagation.
 * Useful for passing context to external services.
 */
export function getTraceContext(): TraceContext | undefined {
  const span = getActiveSpan();
  if (!span) {
    return undefined;
  }

  const spanContext = span.spanContext();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}
