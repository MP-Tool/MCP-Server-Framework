/**
 * Zod Schema Helpers
 *
 * Reusable Zod schema primitives for environment variable parsing.
 * These helpers eliminate repetition in `env.ts` and ensure consistent
 * coercion behavior for common patterns:
 *
 * - Boolean env vars (`"true"` / `"false"` strings)
 * - Comma-separated lists (`"a,b,c"` → `string[]`)
 *
 * @module utils/zod-helpers
 */

import { z } from "zod";
import { splitCommaSeparated, parseByteSize, parseDuration } from "./string-helpers.js";

// ============================================================================
// Boolean Coercion
// ============================================================================

/**
 * Zod schema for boolean environment variables.
 *
 * Accepts both native booleans (from config files) and string values
 * from process.env. Only `"true"` (case-insensitive) maps to `true`,
 * everything else maps to `false`.
 *
 * @param defaultValue - Default value when the env var is not set
 * @returns Zod schema that outputs a `boolean`
 *
 * @example
 * ```typescript
 * // In env schema:
 * OTEL_ENABLED: booleanFromEnv(false),
 * MCP_LEGACY_SSE_ENABLED: booleanFromEnv(false),
 * ```
 */
export function booleanFromEnv(defaultValue: boolean) {
  return z
    .boolean()
    .or(z.string().transform((val) => val.toLowerCase() === "true"))
    .default(defaultValue);
}

// ============================================================================
// Comma-Separated Lists
// ============================================================================

/**
 * Zod schema for comma-separated string list env vars.
 *
 * Splits on `,`, trims whitespace, removes empty segments.
 * Optionally lowercases all values.
 *
 * Use for **required** list fields that always produce a `string[]`.
 * For optional fields that should return `undefined` when empty,
 * use {@link optionalCommaSeparatedList}.
 *
 * @param options - Configuration for list parsing
 * @param options.lowercase - Lowercase all values (default: false)
 * @returns Zod schema that outputs `string[]`
 *
 * @example
 * ```typescript
 * // In env schema:
 * OTEL_METRICS_EXPORTER: commaSeparatedList({ lowercase: true }).default('otlp,prometheus'),
 * ```
 */
export function commaSeparatedList(options: { lowercase?: boolean } = {}) {
  return z.string().transform((val) => splitCommaSeparated(val, options));
}

/**
 * Zod schema for optional comma-separated string list env vars.
 *
 * Like {@link commaSeparatedList}, but returns `undefined` when the
 * input is empty or produces no items after trimming. The resulting
 * field type is `string[] | undefined`.
 *
 * Use for optional list fields where absence has semantic meaning
 * (e.g., "use defaults" for allowed origins/hosts).
 *
 * @returns Zod schema that outputs `string[] | undefined`
 *
 * @example
 * ```typescript
 * // In env schema:
 * MCP_ALLOWED_ORIGINS: optionalCommaSeparatedList(),
 * MCP_ALLOWED_HOSTS: optionalCommaSeparatedList(),
 * ```
 */
export function optionalCommaSeparatedList() {
  return z
    .string()
    .transform((val) => {
      const list = splitCommaSeparated(val);
      return list.length > 0 ? list : undefined;
    })
    .optional();
}

// ============================================================================
// Byte Size
// ============================================================================

/**
 * Zod schema for human-readable byte size environment variables.
 *
 * Accepts strings like `"10mb"`, `"500kb"`, `"1.5gb"`, or plain byte
 * counts like `"1048576"`. Transforms the input to a `number` (bytes)
 * via {@link parseByteSize}.
 *
 * @param defaultValue - Default value as human-readable string (e.g. `'10mb'`)
 * @returns Zod schema that accepts `string` and outputs `number` (bytes)
 *
 * @example
 * ```typescript
 * // In env schema:
 * LOG_MAX_FILE_SIZE: byteSizeSchema('10mb').pipe(z.number().int().min(1024)),
 * ```
 */
export function byteSizeSchema(defaultValue: string) {
  return z
    .string()
    .transform((val) => parseByteSize(val))
    .default(defaultValue);
}

// ============================================================================
// Duration
// ============================================================================

/**
 * Zod schema for human-readable duration environment variables.
 *
 * Accepts strings like `"15m"`, `"1.5h"`, `"500ms"`, `"2d"`, or plain
 * millisecond counts like `"900000"`. Transforms the input to a `number`
 * (milliseconds) via {@link parseDuration}.
 *
 * @param defaultValue - Default value as human-readable string (e.g. `'15m'`)
 * @returns Zod schema that accepts `string` and outputs `number` (milliseconds)
 *
 * @example
 * ```typescript
 * // In env schema:
 * MCP_RATE_LIMIT_WINDOW_MS: durationSchema('15m').pipe(z.number().int().min(1000)),
 * OTEL_METRIC_EXPORT_INTERVAL: durationSchema('60s'),
 * ```
 */
export function durationSchema(defaultValue: string) {
  return z
    .string()
    .transform((val) => parseDuration(val))
    .default(defaultValue);
}
