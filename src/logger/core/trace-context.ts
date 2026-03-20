/**
 * Trace Context Extraction — Plugin Interface
 *
 * Provides a decoupled mechanism for enriching log entries with trace context
 * (traceId, spanId) without the logger module depending on any tracing library.
 *
 * The logger defines the interface; the telemetry layer injects the implementation
 * at startup via {@link setTraceContextExtractor}. Before injection, all calls
 * to {@link extractTraceContext} return `undefined` — safe because no spans
 * can exist before the tracing SDK starts.
 *
 * @module logger/core/trace-context
 */

// ============================================================================
// Interface
// ============================================================================

/** Trace context data returned by the extractor. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * Plugin interface for trace context extraction.
 *
 * Implementations extract the current trace/span IDs from the active
 * tracing context (e.g., OpenTelemetry's active span). The logger calls
 * {@link TraceContextExtractor.extract} on every log entry to enrich
 * structured logs with correlation IDs.
 */
export interface TraceContextExtractor {
  /** Extract the current trace context, or `undefined` if no active span. */
  extract(): TraceContext | undefined;
}

// ============================================================================
// Singleton Slot
// ============================================================================

let extractor: TraceContextExtractor | null = null;

/**
 * Register a trace context extractor implementation.
 *
 * Called by the telemetry layer after SDK initialization to inject
 * an OTEL-based (or custom) extractor. Replaces any previously
 * registered extractor.
 *
 * @param impl - The extractor implementation to register
 */
export function setTraceContextExtractor(impl: TraceContextExtractor): void {
  extractor = impl;
}

/**
 * Extract the current trace context (traceId, spanId).
 *
 * Returns `undefined` when no extractor has been registered yet
 * (i.e., before the telemetry SDK starts). After registration,
 * delegates to the injected extractor.
 *
 * @returns Trace context with traceId and spanId, or `undefined`
 */
export function extractTraceContext(): TraceContext | undefined {
  return extractor?.extract();
}
