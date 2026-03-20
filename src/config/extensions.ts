/**
 * Config Extensions
 *
 * Allows consumer projects to register custom config sections that
 * are recognized during config file loading and validated with
 * consumer-provided Zod schemas.
 *
 * This enables consumer-specific config file sections (e.g., `[myapp]`)
 * without the framework warning about "unknown sections".
 *
 * @example
 * ```typescript
 * import { registerConfigSection, getAppConfig, z } from 'mcp-server-framework';
 *
 * // Register a custom section with a Zod schema
 * registerConfigSection('myapp', z.object({
 *   url: z.string().url(),
 *   timeout_ms: z.number().int().positive().optional(),
 * }));
 *
 * // After config is loaded, retrieve the validated section data
 * const appConfig = getAppConfig<{ url: string; timeout_ms?: number }>('myapp');
 * ```
 *
 * @module config/extensions
 */

import type { ZodTypeAny } from "zod";
import { ConfigurationError } from "../errors/categories/validation.js";
import { isConfigInitialized } from "./config-cache.js";
import { CONFIG_FILE_SECTIONS } from "./file/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A registered config section with its schema and parsed data.
 *
 * @internal
 */
interface RegisteredSection {
  /** Zod schema for validation */
  readonly schema: ZodTypeAny;
  /** Parsed and validated data (set after config file loading) */
  data: unknown;
}

// ============================================================================
// Registry
// ============================================================================

/** Registered consumer config sections */
const registeredSections = new Map<string, RegisteredSection>();

/** Reserved section names derived from the framework config file schema */
const RESERVED_SECTIONS = new Set(Object.keys(CONFIG_FILE_SECTIONS));

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a custom config section for consumer use.
 *
 * Must be called **before** config initialization (i.e., before the
 * first call to `getFrameworkConfig()`). Registered sections:
 *
 * 1. Are recognized in config files (no "unknown section" warning)
 * 2. Are validated against the provided Zod schema
 * 3. Can be retrieved via `getAppConfig(name)`
 *
 * @param name - Section name as it appears in the config file (e.g., 'myapp')
 * @param schema - Zod schema to validate the section data
 * @throws {ConfigurationError} If the section name is reserved, already registered,
 *   or config has already been initialized
 *
 * @example
 * ```typescript
 * registerConfigSection('myapp', z.object({
 *   url: z.string().url(),
 *   api_key: z.string().optional(),
 * }));
 * ```
 */
export function registerConfigSection(name: string, schema: ZodTypeAny): void {
  const sectionName = name.toLowerCase();

  // Guard: Must be called before config initialization
  if (isConfigInitialized()) {
    throw ConfigurationError.invalid(
      `Cannot register config section '${sectionName}': config has already been initialized. ` +
        "Call registerConfigSection() before the first getFrameworkConfig() call.",
    );
  }

  if (RESERVED_SECTIONS.has(sectionName)) {
    throw ConfigurationError.invalid(`Cannot register config section '${sectionName}': reserved by the framework`);
  }

  if (registeredSections.has(sectionName)) {
    throw ConfigurationError.invalid(`Config section '${sectionName}' is already registered`);
  }

  registeredSections.set(sectionName, { schema, data: undefined });
}

/**
 * Retrieve the validated data for a registered config section.
 *
 * Returns `undefined` if:
 * - The section was not present in the config file
 * - Config has not been loaded yet
 *
 * @param name - Section name (case-insensitive)
 * @returns The validated section data, or `undefined`
 *
 * @example
 * ```typescript
 * interface MyAppConfig {
 *   url: string;
 *   timeout_ms?: number;
 * }
 * const config = getAppConfig<MyAppConfig>('myapp');
 * if (config) {
 *   console.log(config.url);
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Intentional: T enables consumer-side type inference
export function getAppConfig<T = unknown>(name: string): T | undefined {
  const section = registeredSections.get(name.toLowerCase());
  // @type-narrowing — section.data is `unknown`; caller provides generic T for domain-specific typing
  return section?.data as T | undefined;
}

// ============================================================================
// Internal API (used by loader)
// ============================================================================

/**
 * Get all registered consumer section names.
 *
 * Used by the config file loader to recognize consumer sections
 * and suppress "unknown section" warnings.
 *
 * @internal
 */
export function getRegisteredSectionNames(): ReadonlySet<string> {
  return new Set(registeredSections.keys());
}

/**
 * Get the Zod schema for a registered section.
 *
 * @internal
 */
export function getRegisteredSectionSchema(name: string): ZodTypeAny | undefined {
  return registeredSections.get(name.toLowerCase())?.schema;
}

/**
 * Store validated data for a registered section.
 *
 * Called by the config file loader after parsing and validating
 * a consumer section from the config file.
 *
 * @internal
 */
export function setRegisteredSectionData(name: string, data: unknown): void {
  const section = registeredSections.get(name.toLowerCase());
  if (section) {
    section.data = data;
  }
}

/**
 * Reset all registered config sections.
 *
 * Intended for testing — clears all registrations and data.
 *
 * @internal
 */
export function resetConfigExtensions(): void {
  registeredSections.clear();
}
