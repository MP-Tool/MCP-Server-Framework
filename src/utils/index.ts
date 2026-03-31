/**
 * Server Framework Utilities
 *
 * Generic utilities for the MCP server framework.
 * Re-exports shared utilities from the main utils module.
 *
 * @module utils
 */

// Re-export shared env helpers from main utils
export { parseEnvBoolean, getEnvString, getEnvOptional } from "./env-helpers.js";

// Re-export validation helpers
export {
  validateName,
  validateNonEmptyString,
  validateFunction,
  validateZodSchema,
  validateObject,
  validateEnum,
  validateDefinitionBase,
} from "./validation.js";

// Re-export sensitive key detection
export { isSensitiveKey, SENSITIVE_KEYS, SENSITIVE_KEY_BLOCKLIST } from "./sensitive-keys.js";

// Re-export string helpers
export {
  splitCommaSeparated,
  interpolate,
  type MessageParams,
  truncateId,
  isLocalHost,
  stripTrailingSlashes,
  parseByteSize,
  BYTE_SIZE_REGEX,
  parseDuration,
  formatDuration,
  DURATION_REGEX,
} from "./string-helpers.js";

// Re-export Zod schema helpers
export {
  booleanFromEnv,
  commaSeparatedList,
  optionalCommaSeparatedList,
  byteSizeSchema,
  durationSchema,
} from "./zod-helpers.js";
