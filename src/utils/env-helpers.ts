/**
 * Environment Variable Helpers
 *
 * Utilities for parsing and handling environment variables.
 *
 * @module utils/env-helpers
 */

/** Accepted boolean spellings, keyed lowercase. */
const ENV_BOOLEAN_VALUES: Readonly<Record<string, boolean>> = {
  true: true,
  "1": true,
  yes: true,
  on: true,
  false: false,
  "0": false,
  no: false,
  off: false,
};

/**
 * Read a boolean spelling strictly: `undefined` when it is not one of
 * `true/false/1/0/yes/no/on/off` (case-insensitive, surrounding whitespace ignored).
 * Schemas use this to reject a typo instead of silently treating it as false.
 */
export function lookupEnvBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENV_BOOLEAN_VALUES, normalized)
    ? ENV_BOOLEAN_VALUES[normalized]
    : undefined;
}

/**
 * Parse an environment value as a boolean, for callers without a way to report a bad value.
 * Unset, empty and unrecognized values read as `false`; config schemas use the strict
 * `booleanFromEnv` / `optionalBooleanFromEnv` instead.
 *
 * @example
 * ```typescript
 * parseEnvBoolean('TRUE')    // true
 * parseEnvBoolean('1')       // true
 * parseEnvBoolean('off')     // false
 * parseEnvBoolean('maybe')   // false
 * parseEnvBoolean(undefined) // false
 * parseEnvBoolean(true)      // true (passthrough)
 * ```
 */
export function parseEnvBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return value !== undefined && lookupEnvBoolean(value) === true;
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
