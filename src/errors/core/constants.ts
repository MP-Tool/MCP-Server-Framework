/**
 * Constants Module
 *
 * Constants related to validation and data sanitization:
 * - Display limits for error messages
 * - Sensitive field patterns for redaction
 *
 * @module errors/core/constants
 */

// ============================================================================
// Validation Display Limits
// ============================================================================

/**
 * Validation limits for error handling.
 *
 * Used to truncate values displayed in error messages
 * to prevent overly long outputs and potential data leaks.
 */
export const VALIDATION_LIMITS = {
  /** Maximum string length to display in error messages */
  MAX_STRING_DISPLAY_LENGTH: 100,
  /** Maximum array items to display in error messages */
  MAX_ARRAY_DISPLAY_ITEMS: 5,
  /** Maximum object keys to display in error messages */
  MAX_OBJECT_DISPLAY_KEYS: 5,
} as const;

// ============================================================================
// Sensitive Field Patterns
// ============================================================================

/**
 * Redaction placeholder for sensitive values in error serialization.
 *
 * Named distinctly from the logger's `REDACTED_VALUE` ('**********')
 * to avoid confusion: errors use bracket-style placeholders,
 * the logger uses mask-style replacement.
 */
export const REDACTED_PLACEHOLDER = "[REDACTED]" as const;
