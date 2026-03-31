/**
 * String Helpers
 *
 * Generic string manipulation utilities used across the framework.
 *
 * @module utils/string-helpers
 */

// ============================================================================
// Comma-Separated Parsing
// ============================================================================

/**
 * Split a comma-separated string into trimmed, non-empty segments.
 *
 * Used by Zod schema helpers and config file mappers to provide
 * a single source of truth for CSV-style string parsing.
 *
 * @param value - Raw comma-separated string (e.g., `"a, b, c"`)
 * @param options - Parsing options
 * @param options.lowercase - Lowercase all segments (default: false)
 * @returns Array of trimmed, non-empty strings
 *
 * @example
 * ```typescript
 * splitCommaSeparated('a, b, c');              // ['a', 'b', 'c']
 * splitCommaSeparated('A, B', { lowercase: true }); // ['a', 'b']
 * splitCommaSeparated('');                     // []
 * splitCommaSeparated(' , , ');                // []
 * ```
 */
export function splitCommaSeparated(value: string, options: { lowercase?: boolean } = {}): string[] {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return options.lowercase ? items.map((s) => s.toLowerCase()) : items;
}

// ============================================================================
// Template Interpolation
// ============================================================================

/**
 * Cached regex for template interpolation.
 * Pattern matches `{variableName}` placeholders.
 */
const INTERPOLATION_REGEX = /\{(\w+)\}/g;

/**
 * Interpolation parameters type.
 * Maps template variable names to their values.
 */
export type MessageParams = Record<string, string | number | boolean | undefined>;

/**
 * Interpolate a template string with parameters.
 *
 * Replaces `{variableName}` placeholders with values from the params object.
 * Unmatched placeholders are preserved as-is.
 *
 * @param template - The template string with `{variable}` placeholders
 * @param params - The parameters to interpolate
 * @returns The interpolated string
 *
 * @example
 * ```typescript
 * interpolate("Hello {name}!", { name: "World" })
 * // "Hello World!"
 * ```
 */
export function interpolate(template: string, params: MessageParams): string {
  INTERPOLATION_REGEX.lastIndex = 0;
  return template.replace(INTERPOLATION_REGEX, (match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      return match;
    }
    return String(value);
  });
}

// ============================================================================
// ID Truncation
// ============================================================================

/** Default display length for truncated IDs. */
const DEFAULT_ID_DISPLAY_LENGTH = 8;

/**
 * Truncate an ID string (session, request, trace) for display purposes.
 *
 * Keeps logs readable while providing enough uniqueness for debugging.
 * Also avoids exposing full tokens in log output.
 *
 * @param id - The full ID string
 * @param length - Number of characters to keep (default: 8)
 * @returns Truncated ID
 *
 * @example
 * ```typescript
 * truncateId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
 * // Returns: 'a1b2c3d4'
 * ```
 */
export function truncateId(id: string, length = DEFAULT_ID_DISPLAY_LENGTH): string {
  return id.substring(0, length);
}

// ============================================================================
// Byte Size Parsing
// ============================================================================

/**
 * Regex pattern for human-readable byte sizes.
 *
 * Matches formats like `"10mb"`, `"1.5gb"`, `"500kb"`, or plain byte
 * counts like `"1048576"`. Case-insensitive, optional whitespace
 * between number and unit.
 *
 * Shared with Zod schemas (`MCP_BODY_SIZE_LIMIT`, `LOG_MAX_FILE_SIZE`)
 * to ensure consistent validation across env vars and config files.
 *
 * @example
 * ```typescript
 * BYTE_SIZE_REGEX.test('10mb');      // true
 * BYTE_SIZE_REGEX.test('1.5 gb');    // true
 * BYTE_SIZE_REGEX.test('1048576');   // true (plain bytes)
 * BYTE_SIZE_REGEX.test('abc');       // false
 * ```
 */
export const BYTE_SIZE_REGEX = /^\d+(\.\d+)?\s*(kb|mb|gb|tb|pb)?$/i;

/**
 * Binary unit multipliers (1 KB = 1024 bytes).
 * @internal
 */
const BYTE_MULTIPLIERS: Readonly<Record<string, number>> = {
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
};

/**
 * Parse a human-readable byte size string into a number of bytes.
 *
 * Accepts formats like `"10mb"`, `"1.5gb"`, `"500kb"`, or plain numeric
 * strings like `"1048576"` (interpreted as bytes). Uses binary units
 * (1 KB = 1024 bytes, 1 MB = 1048576 bytes, etc.).
 *
 * The supported units match the `MCP_BODY_SIZE_LIMIT` regex pattern
 * used throughout the framework: `kb`, `mb`, `gb`, `tb`, `pb`.
 *
 * @param value - Human-readable size string (e.g. `"10mb"`, `"1048576"`)
 * @returns Number of bytes (floored to integer)
 * @throws {Error} If the format is invalid
 *
 * @example
 * ```typescript
 * parseByteSize('10mb');      // 10485760
 * parseByteSize('500kb');     // 512000
 * parseByteSize('1.5gb');     // 1610612736
 * parseByteSize('1048576');   // 1048576 (plain bytes)
 * ```
 */
export function parseByteSize(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|pb)?$/i);

  if (!match) {
    throw new Error(
      `Invalid byte size format: "${value}". Use formats like "10mb", "500kb", "2gb", or a plain byte count like "1048576".`,
    );
  }

  const num = parseFloat(match[1]!);
  const unit = match[2]?.toLowerCase();

  if (!unit) {
    return Math.floor(num);
  }

  return Math.floor(num * (BYTE_MULTIPLIERS[unit] ?? 1));
}

// ============================================================================
// Duration Parsing
// ============================================================================

/**
 * Regex pattern for human-readable durations.
 *
 * Matches formats like `"15m"`, `"1.5h"`, `"500ms"`, or plain
 * millisecond counts like `"900000"`. Case-insensitive, optional
 * whitespace between number and unit.
 *
 * Shared with Zod schemas (`MCP_RATE_LIMIT_WINDOW_MS`, `OTEL_METRIC_EXPORT_INTERVAL`)
 * to ensure consistent validation across env vars and config files.
 *
 * @example
 * ```typescript
 * DURATION_REGEX.test('15m');       // true
 * DURATION_REGEX.test('1.5 h');     // true
 * DURATION_REGEX.test('900000');    // true (plain ms)
 * DURATION_REGEX.test('abc');       // false
 * ```
 */
export const DURATION_REGEX = /^\d+(\.\d+)?\s*(ms|s|m|h|d|w)?$/i;

/**
 * Duration unit multipliers (all units → milliseconds).
 * @internal
 */
const DURATION_MULTIPLIERS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepts formats like `"15m"`, `"1.5h"`, `"500ms"`, `"2d"`, or plain
 * numeric strings like `"900000"` (interpreted as milliseconds). Uses
 * standard time units:
 *
 * | Unit | Meaning      | Multiplier  |
 * |------|-------------|-------------|
 * | ms   | milliseconds | 1           |
 * | s    | seconds      | 1,000       |
 * | m    | minutes      | 60,000      |
 * | h    | hours        | 3,600,000   |
 * | d    | days         | 86,400,000  |
 * | w    | weeks        | 604,800,000 |
 *
 * @param value - Human-readable duration string (e.g. `"15m"`, `"900000"`)
 * @returns Duration in milliseconds (floored to integer)
 * @throws {Error} If the format is invalid
 *
 * @example
 * ```typescript
 * parseDuration('15m');       // 900000
 * parseDuration('1.5h');      // 5400000
 * parseDuration('500ms');     // 500
 * parseDuration('2d');        // 172800000
 * parseDuration('900000');    // 900000 (plain ms)
 * ```
 */
export function parseDuration(value: string): number {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);

  if (!match) {
    throw new Error(
      `Invalid duration format: "${value}". Use formats like "15m", "1.5h", "500ms", "2d", or a plain millisecond count like "900000".`,
    );
  }

  const num = parseFloat(match[1]!);
  const unit = match[2]?.toLowerCase();

  if (!unit) {
    return Math.floor(num);
  }

  return Math.floor(num * (DURATION_MULTIPLIERS[unit] ?? 1));
}

/**
 * Format milliseconds as a human-readable duration string.
 *
 * Inverse of {@link parseDuration}. Produces the most natural unit
 * for the given value, using at most two segments (e.g. `"1m 30s"`).
 *
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string
 *
 * @example
 * ```typescript
 * formatDuration(500);        // "500ms"
 * formatDuration(5000);       // "5s"
 * formatDuration(90_000);     // "1m 30s"
 * formatDuration(900_000);    // "15m"
 * formatDuration(3_600_000);  // "1h"
 * formatDuration(86_400_000); // "1d"
 * ```
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.round((ms % 86_400_000) / 3_600_000);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

// ============================================================================
// Network Helpers
// ============================================================================

/**
 * Check if a host string is a localhost/loopback address.
 *
 * @param host - The host string to check (e.g., 'localhost:3000', '192.168.1.1')
 * @returns true if the host is a local loopback address
 *
 * @example
 * ```typescript
 * isLocalHost('localhost:3000');  // true
 * isLocalHost('127.0.0.1');       // true
 * isLocalHost('[::1]:8080');      // true
 * isLocalHost('192.168.1.1');     // false
 * ```
 */
export function isLocalHost(host: string): boolean {
  const cleanHost = host.trim().toLowerCase();
  return (
    cleanHost.startsWith("localhost:") ||
    cleanHost === "localhost" ||
    cleanHost.startsWith("127.0.0.1:") ||
    cleanHost === "127.0.0.1" ||
    cleanHost.startsWith("[::1]:") ||
    cleanHost === "[::1]"
  );
}

/**
 * Removes trailing slash characters from a string.
 *
 * Uses a linear scan instead of regex to avoid polynomial ReDoS
 * on attacker-controlled input (CWE-1333).
 *
 * @example
 * ```typescript
 * stripTrailingSlashes('https://example.com/');   // 'https://example.com'
 * stripTrailingSlashes('https://example.com///'); // 'https://example.com'
 * stripTrailingSlashes('https://example.com');    // 'https://example.com'
 * ```
 */
export function stripTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 47) end--; // 47 = '/'
  return end === str.length ? str : str.slice(0, end);
}
