/**
 * Builder Validation
 *
 * Validates builder state before server construction.
 * Extracted from McpServerBuilder.build() for single responsibility.
 *
 * @module server/builder/validation
 */

import type { ServerOptions } from "../server-options.js";
import type { BuilderState } from "./types.js";
import { BuilderMessages } from "./constants.js";
import { ConfigurationError } from "../../errors/categories/validation.js";

// ============================================================================
// Validated Options Type
// ============================================================================

/**
 * Server options after validation — name and version are guaranteed non-empty.
 *
 * This type narrows the optional fields to their required forms
 * so downstream code doesn't need redundant null checks.
 */
export interface ValidatedServerOptions extends ServerOptions {
  readonly name: string;
  readonly version: string;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates that the builder state is ready for server construction.
 *
 * Checks:
 * - Builder has not been used before (single-use guard)
 * - Options have been configured via withOptions()
 * - Server name is present and non-empty
 * - Server version is present and non-empty
 *
 * @param state - Current builder state
 * @param built - Whether this builder instance has already been used
 * @returns Validated options with guaranteed name and version
 * @throws ConfigurationError if any validation fails
 */
export function validateBuilderState(state: BuilderState, built: boolean): ValidatedServerOptions {
  if (built) {
    throw ConfigurationError.constraintViolation(BuilderMessages.ALREADY_BUILT, ["build"]);
  }

  if (!state.options) {
    throw ConfigurationError.constraintViolation(BuilderMessages.OPTIONS_REQUIRED, ["options"]);
  }

  if (!state.options.name.trim()) {
    throw ConfigurationError.constraintViolation(BuilderMessages.NAME_REQUIRED, ["options.name"]);
  }

  if (!state.options.version.trim()) {
    throw ConfigurationError.constraintViolation(BuilderMessages.VERSION_REQUIRED, ["options.version"]);
  }

  // @type-narrowing — validated above, but TS doesn't narrow through conditionals on readonly props
  return state.options as ValidatedServerOptions;
}
