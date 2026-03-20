/**
 * Environment Variable Helpers
 *
 * Utilities for parsing and handling environment variables.
 *
 * @module utils/env-helpers
 */

/**
 * Parse an environment variable as a boolean.
 *
 * Environment variables are always strings, so this helper provides
 * consistent boolean parsing across the codebase. Also handles
 * the case where a boolean is passed through directly (e.g., from
 * a pre-parsed config object).
 *
 * @param value - The environment variable value
 * @returns true if value equals 'true' (case-insensitive) or is boolean true, false otherwise
 *
 * @example
 * ```typescript
 * parseEnvBoolean('true')   // true
 * parseEnvBoolean('TRUE')   // true
 * parseEnvBoolean('True')   // true
 * parseEnvBoolean('false')  // false
 * parseEnvBoolean('1')      // false
 * parseEnvBoolean(undefined) // false
 * parseEnvBoolean(true)     // true (passthrough)
 * ```
 */
export function parseEnvBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return value?.toLowerCase() === "true";
}

/**
 * Get an environment variable with a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns The environment variable value or default
 */
export function getEnvString(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

/**
 * Get an optional environment variable.
 *
 * @param name - Environment variable name
 * @returns The environment variable value or undefined
 */
export function getEnvOptional(name: string): string | undefined {
  return process.env[name];
}
