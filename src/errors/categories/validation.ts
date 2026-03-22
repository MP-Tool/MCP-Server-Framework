/**
 * Validation Error Classes
 *
 * Errors related to input validation and configuration:
 * - ValidationError: Input validation failures
 * - ConfigurationError: Configuration/environment errors
 *
 * @module errors/categories/validation
 */

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { AppError, ErrorCodes, VALIDATION_LIMITS, REDACTED_PLACEHOLDER, isSensitiveKey } from "../core/index.js";
import type { ValidationErrorOptions, ValidationIssue, BaseErrorOptions } from "../core/index.js";

// ============================================================================
// Validation Error
// ============================================================================

/**
 * Error thrown when input validation fails.
 *
 * Integrates with Zod for schema validation errors.
 *
 * @example
 * ```typescript
 * // From Zod error
 * throw ValidationError.fromZodError(zodError, 'Invalid server configuration');
 *
 * // Manual validation
 * throw new ValidationError('Server name is required', {
 *   field: 'server',
 *   value: undefined
 * });
 *
 * // Using factory methods
 * throw ValidationError.fieldRequired('server');
 * ```
 */
export class ValidationError extends AppError {
  /** The field that failed validation */
  readonly field?: string | undefined;

  /** The invalid value (sanitized) */
  readonly value?: unknown;

  /** All validation issues (for multi-field validation) */
  readonly issues?: ValidationIssue[] | undefined;

  constructor(message: string, options: ValidationErrorOptions = {}) {
    super(message, {
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 400,
      mcpCode: ErrorCode.InvalidParams,
      cause: options.cause,
      recoveryHint: options.recoveryHint,
      context: {
        ...options.context,
        field: options.field,
        // Don't include actual value in context to avoid sensitive data leaks
        hasValue: options.value !== undefined,
      },
    });

    this.field = options.field;
    // Sanitize the value - don't store sensitive information
    this.value = this.sanitizeValue(options.value, options.field);
    this.issues = options.issues;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Value Sanitization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sanitize a value for safe storage/logging.
   * Removes potential sensitive data.
   */
  private sanitizeValue(value: unknown, fieldName?: string): unknown {
    if (value === undefined || value === null) {
      return value;
    }

    // Check for potential secrets based on field name
    if (fieldName && isSensitiveKey(fieldName)) {
      return REDACTED_PLACEHOLDER;
    }

    // For strings, truncate and indicate type
    if (typeof value === "string") {
      if (value.length > VALIDATION_LIMITS.MAX_STRING_DISPLAY_LENGTH) {
        return `[string:${value.length} chars]`;
      }
      return value;
    }

    // For objects/arrays, indicate structure only
    if (typeof value === "object") {
      if (Array.isArray(value)) {
        return `[array:${value.length} items]`;
      }
      return `[object:${Object.keys(value).length} keys]`;
    }

    return value;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a ValidationError from a Zod error.
   */
  static fromZodError(zodError: ZodError, message?: string): ValidationError {
    const issues: ValidationIssue[] = zodError.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));

    const primaryIssue = issues[0];
    const errorMessage = message || primaryIssue?.message || "Validation failed";

    return new ValidationError(errorMessage, {
      field: primaryIssue?.path,
      issues,
      cause: zodError,
      recoveryHint: "Check the input parameters against the expected schema.",
    });
  }

  /**
   * Create a ValidationError for a required field.
   */
  static fieldRequired(field: string): ValidationError {
    return new ValidationError(`Field '${field}' is required`, {
      field,
      recoveryHint: `Provide a value for the required field '${field}'.`,
    });
  }

  /**
   * Create a ValidationError for an invalid field value.
   */
  static fieldInvalid(field: string, value?: unknown): ValidationError {
    return new ValidationError(`Invalid value for field '${field}'`, {
      field,
      value,
      recoveryHint: `Check the value provided for '${field}' and ensure it meets the requirements.`,
    });
  }

  /**
   * Create a ValidationError for a type mismatch.
   */
  static fieldTypeMismatch(field: string, expectedType: string): ValidationError {
    return new ValidationError(`Field '${field}' must be of type ${expectedType}`, {
      field,
      recoveryHint: `Field '${field}' must be of type '${expectedType}'.`,
    });
  }

  /**
   * Create a ValidationError for minimum value constraint.
   */
  static fieldMin(field: string, min: number): ValidationError {
    return new ValidationError(`Field '${field}' must be at least ${min}`, {
      field,
      recoveryHint: `Provide a value of at least ${min} for '${field}'.`,
    });
  }

  /**
   * Create a ValidationError for maximum value constraint.
   */
  static fieldMax(field: string, max: number): ValidationError {
    return new ValidationError(`Field '${field}' must be at most ${max}`, {
      field,
      recoveryHint: `Provide a value of at most ${max} for '${field}'.`,
    });
  }

  /**
   * Create a ValidationError for pattern mismatch.
   */
  static fieldPattern(field: string): ValidationError {
    return new ValidationError(`Field '${field}' does not match the required pattern`, {
      field,
      recoveryHint: `Ensure '${field}' matches the expected format.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Formatting
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Format issues as a human-readable list.
   */
  formatIssues(): string {
    if (!this.issues || this.issues.length === 0) {
      return this.message;
    }

    return this.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
  }
}

// ============================================================================
// Configuration Error
// ============================================================================

/**
 * Error thrown when configuration is invalid.
 *
 * @example
 * ```typescript
 * throw new ConfigurationError('Missing required environment variable: API_URL');
 *
 * // Using factory methods
 * throw ConfigurationError.missingEnvVar('API_URL');
 * throw ConfigurationError.invalidEnvVar('API_PORT', 'must be a number');
 * ```
 */
export class ConfigurationError extends AppError {
  /** The configuration key that is invalid */
  readonly configKey?: string | undefined;

  constructor(
    message: string,
    options: Omit<BaseErrorOptions, "code"> & {
      configKey?: string | undefined;
    } = {},
  ) {
    super(message, {
      code: ErrorCodes.CONFIGURATION_ERROR,
      statusCode: 500, // Configuration errors are server-side
      mcpCode: ErrorCode.InternalError,
      cause: options.cause,
      context: {
        ...options.context,
        configKey: options.configKey,
      },
    });

    this.configKey = options.configKey;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a ConfigurationError for a missing environment variable.
   */
  static missingEnvVar(varName: string): ConfigurationError {
    return new ConfigurationError(`Missing required environment variable: ${varName}`, {
      configKey: varName,
      recoveryHint: `Set the environment variable '${varName}' in your configuration.`,
    });
  }

  /**
   * Create a ConfigurationError for an invalid environment variable value.
   */
  static invalidEnvVar(varName: string, reason: string): ConfigurationError {
    return new ConfigurationError(`Invalid value for environment variable ${varName}: ${reason}`, {
      configKey: varName,
      recoveryHint: `Check the value of '${varName}': ${reason}.`,
    });
  }

  /**
   * Create a ConfigurationError with a custom message.
   */
  static invalid(message: string): ConfigurationError {
    return new ConfigurationError(`Invalid configuration: ${message}`, {
      recoveryHint: "Review your configuration settings and correct any issues.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Config File Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a ConfigurationError for an explicitly specified config file that doesn't exist.
   */
  static fileNotFound(filePath: string): ConfigurationError {
    return new ConfigurationError(`Config file not found: ${filePath}`, {
      configKey: "MCP_CONFIG_FILE_PATH",
      recoveryHint: `Ensure the file '${filePath}' exists or remove the MCP_CONFIG_FILE_PATH environment variable.`,
    });
  }

  /**
   * Create a ConfigurationError for a file that could not be read.
   */
  static fileReadFailed(filePath: string, cause?: Error): ConfigurationError {
    return new ConfigurationError(`Failed to read config file: ${filePath}`, {
      configKey: "MCP_CONFIG_FILE_PATH",
      cause,
      recoveryHint: `Check file permissions and path for '${filePath}'.`,
    });
  }

  /**
   * Create a ConfigurationError for a TOML/YAML parse failure.
   */
  static fileParseFailed(filePath: string, cause?: Error): ConfigurationError {
    return new ConfigurationError(`Failed to parse config file: ${filePath}`, {
      configKey: "MCP_CONFIG_FILE_PATH",
      cause,
      recoveryHint: `Check the syntax of '${filePath}' — ensure it is valid TOML or YAML.`,
    });
  }

  /**
   * Create a ConfigurationError for schema validation failures in a config file.
   *
   * Formats Zod issues into a human-readable message with the file path
   * so users can locate and fix typos or invalid values.
   */
  static fileValidationFailed(filePath: string, zodError: ZodError): ConfigurationError {
    const issues = zodError.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    const detail = `Validation failed for '${filePath}':\n${issues}`;

    return new ConfigurationError(detail, {
      configKey: "MCP_CONFIG_FILE_PATH",
      cause: zodError,
      recoveryHint: "Fix the listed issues in your config file. Use `.strict()` sections to catch typos.",
    });
  }

  /**
   * Create a ConfigurationError for an unsupported config file extension.
   */
  static unsupportedFormat(extension: string): ConfigurationError {
    return new ConfigurationError(`Unsupported config file format: ${extension}. Supported: .toml, .yaml, .yml`, {
      configKey: "MCP_CONFIG_FILE_PATH",
      recoveryHint: `Supported formats: .toml, .yaml, .yml`,
    });
  }

  /**
   * Create a ConfigurationError for cross-field validation failures.
   *
   * Used after merging all config sources (env + file + overrides)
   * to validate constraints that span multiple fields.
   */
  static constraintViolation(message: string, fields: string[]): ConfigurationError {
    return new ConfigurationError(message, {
      context: { fields },
      recoveryHint: `Check the relationship between: ${fields.join(", ")}`,
    });
  }
}
