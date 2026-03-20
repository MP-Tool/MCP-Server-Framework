/**
 * Definition Validation
 *
 * Runtime validation helpers for define*() factory functions.
 * Catches misconfigurations early with clear, actionable error messages.
 *
 * These validations complement TypeScript's compile-time checks by catching:
 * - Empty strings (valid `string` but invalid as identifiers)
 * - Wrong types from JavaScript consumers or dynamic definitions
 * - Missing required fields in loose object literals
 *
 * @internal Not exported from the public API.
 * @module utils/validation
 */

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that a definition name is a non-empty string.
 *
 * @param name - The name value to validate
 * @param type - Definition type for error context (e.g., 'Tool', 'Resource')
 * @throws TypeError if name is not a non-empty string
 */
export function validateName(name: unknown, type: string): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError(`${type} definition requires a non-empty 'name', received: ${String(name)}`);
  }
}

/**
 * Validate that a string field is non-empty.
 *
 * @param value - The value to validate
 * @param type - Definition type for error context
 * @param field - Field name for error context
 * @throws TypeError if value is not a non-empty string
 */
export function validateNonEmptyString(value: unknown, type: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${type} definition requires a non-empty '${field}', received: ${String(value)}`);
  }
}

/**
 * Validate that a value is a function.
 *
 * @param value - The value to validate
 * @param type - Definition type for error context
 * @param field - Field name for error context
 * @throws TypeError if value is not a function
 */
export function validateFunction(
  value: unknown,
  type: string,
  field: string,
): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(`${type} definition requires '${field}' to be a function, received: ${typeof value}`);
  }
}

/**
 * Validate that a value is a Zod schema (duck-type check).
 *
 * Performs a minimal structural check for Zod-like objects by verifying
 * the presence of `.parse()`. This is intentionally loose to support
 * different Zod versions and custom schema wrappers.
 *
 * @param schema - The value to validate
 * @param type - Definition type for error context
 * @param field - Field name for error context
 * @throws TypeError if value doesn't look like a Zod schema
 */
export function validateZodSchema(schema: unknown, type: string, field: string): void {
  if (schema == null || typeof schema !== "object" || !("parse" in schema)) {
    throw new TypeError(
      `${type} definition requires '${field}' to be a Zod schema (object with .parse()), received: ${typeof schema}`,
    );
  }
}

/**
 * Validate that a value is a non-null object (not an array).
 *
 * @param value - The value to validate
 * @param type - Definition type for error context
 * @param field - Field name for error context
 * @throws TypeError if value is not a plain object
 */
export function validateObject(value: unknown, type: string, field: string): asserts value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${type} definition requires '${field}' to be an object, received: ${typeof value}`);
  }
}

/**
 * Validate that a value is one of the allowed enum values.
 *
 * @param value - The value to validate
 * @param allowed - Array of allowed string values
 * @param type - Definition type for error context
 * @param field - Field name for error context
 * @throws TypeError if value is not one of the allowed values
 */
export function validateEnum(
  value: unknown,
  allowed: readonly string[],
  type: string,
  field: string,
): asserts value is string {
  if (!allowed.includes(value as string)) {
    throw new TypeError(
      `${type} definition requires '${field}' to be one of [${allowed.join(", ")}], received: '${String(value)}'`,
    );
  }
}

/**
 * Validate common definition fields: name (non-empty string) and description (non-empty string).
 * Shared across all define*() factory functions.
 *
 * @param definition - Object with name and description fields
 * @param type - Definition type for error context (e.g., 'Tool', 'Resource')
 */
export function validateDefinitionBase(definition: { name: unknown; description: unknown }, type: string): void {
  validateName(definition.name, type);
  validateNonEmptyString(definition.description, type, "description");
}
