/**
 * Config File Loader
 *
 * Orchestrates the config file loading pipeline:
 * 1. Discover config file (explicit path or auto-discovery)
 * 2. Parse raw content (TOML, YAML, or JSON)
 * 3. Validate against schema (lenient — unknown keys are stripped)
 * 4. Warn about unknown keys (typo detection without crashing)
 * 5. Map nested structure to flat `FrameworkEnvConfig` overrides
 *
 * Returns `undefined` when no config file is found — this is the
 * normal case for servers that rely solely on environment variables.
 *
 * @module config/file/loader
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import { ConfigurationError } from "../../errors/categories/validation.js";
import { addStartupWarning } from "../startup-warnings.js";
import { getRegisteredSectionNames, getRegisteredSectionSchema, setRegisteredSectionData } from "../extensions.js";
import {
  configFileSchema,
  CONFIG_FILE_SECTIONS,
  mapConfigToOverrides,
  CONFIG_FILE_ENV_VAR,
  DISCOVERY_FILENAMES,
  EXTENSION_FORMAT_MAP,
} from "./schema.js";
import type { ConfigFileFormat, ConfigFileResult } from "./schema.js";

// ============================================================================
// Loader (Public API)
// ============================================================================

/**
 * Load and validate a config file.
 *
 * This is the single entry point for the config file subsystem.
 * The result contains `Partial<FrameworkEnvConfig>` overrides that
 * can be applied via `applyConfigOverrides()`.
 *
 * Unknown keys are stripped during validation and logged as warnings
 * so typos are visible without preventing the server from starting.
 *
 * @returns Config file result with overrides and metadata, or `undefined` if no file found
 * @throws {ConfigurationError} On discovery, parse, or validation errors
 */
export function loadConfigFile(): ConfigFileResult | undefined {
  // Step 1: Discover
  const filePath = discoverConfigFile();
  if (!filePath) {
    return undefined;
  }

  // Step 2: Parse
  const { data, format } = parseConfigFile(filePath);

  // Step 3: Warn about unknown keys (before schema strips them)
  warnUnknownKeys(data, filePath);

  // Step 4: Validate framework sections (unknown keys are silently stripped by Zod defaults)
  const parseResult = configFileSchema.safeParse(data);
  if (!parseResult.success) {
    throw ConfigurationError.fileValidationFailed(filePath, parseResult.error);
  }

  // Step 5: Validate and store registered consumer sections
  processConsumerSections(data, filePath);

  // Step 6: Map to overrides
  const overrides = mapConfigToOverrides(parseResult.data);

  return { overrides, sourcePath: filePath, format };
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Discover the config file path.
 *
 * Resolution order:
 * 1. `MCP_CONFIG_FILE_PATH` env var — explicit path (must exist, must be supported format)
 * 2. Auto-discovery in `process.cwd()` — first match from {@link DISCOVERY_FILENAMES}
 *
 * @returns Absolute path to the config file, or `undefined` if none found
 * @throws {ConfigurationError} If explicit path doesn't exist or has unsupported extension
 */
function discoverConfigFile(): string | undefined {
  const explicitPath = process.env[CONFIG_FILE_ENV_VAR];

  if (explicitPath) {
    return resolveExplicitPath(explicitPath);
  }

  return autoDiscover();
}

/**
 * Resolve an explicitly specified config file path.
 *
 * An explicit path MUST have a supported extension — an unsupported
 * extension is always a hard error (typo in env var).
 *
 * A missing file is treated as a soft warning: the consumer may have
 * set `MCP_CONFIG_FILE_PATH` for a file that doesn't exist yet in
 * the current environment (e.g. Docker volume not mounted). The server
 * continues without config-file values.
 */
function resolveExplicitPath(rawPath: string): string | undefined {
  const absolutePath = resolve(rawPath);
  const ext = extname(absolutePath).toLowerCase();

  if (!EXTENSION_FORMAT_MAP[ext]) {
    throw ConfigurationError.unsupportedFormat(ext);
  }

  // Check existence and file-type
  let isFile = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- config path from trusted env var
    isFile = statSync(absolutePath).isFile();
  } catch {
    // file doesn't exist or is inaccessible — handled below
  }

  if (!isFile) {
    addStartupWarning(
      `Config file not found: ${absolutePath} (set via ${CONFIG_FILE_ENV_VAR}). ` +
        `Continuing without config file — using environment variables only.`,
    );
    return undefined;
  }

  return absolutePath;
}

/**
 * Auto-discover a config file in the current working directory.
 *
 * Iterates {@link DISCOVERY_FILENAMES} in priority order.
 * Returns `undefined` if no config file is found — this is the normal
 * case for servers that rely solely on environment variables.
 */
function autoDiscover(): string | undefined {
  const cwd = process.cwd();

  for (const filename of DISCOVERY_FILENAMES) {
    const candidate = resolve(cwd, filename);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- candidate is resolved from safe DISCOVERY_FILENAMES list
    if (existsSync(candidate)) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- same as above
        const stat = statSync(candidate);
        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }

  return undefined;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a config file into a raw object.
 *
 * Delegates to the appropriate parser based on file extension.
 * Returns a plain object — validation/mapping happens in the schema layer.
 *
 * @param filePath - Absolute path to the config file
 * @returns Parsed raw object and detected format
 * @throws {ConfigurationError} On read errors, unsupported format, or parse failures
 */
function parseConfigFile(filePath: string): {
  data: Record<string, unknown>;
  format: ConfigFileFormat;
} {
  const ext = extname(filePath).toLowerCase();
  const format = EXTENSION_FORMAT_MAP[ext];

  if (!format) {
    throw ConfigurationError.unsupportedFormat(ext);
  }

  const content = readFileSafe(filePath);
  const data = parseContent(content, format, filePath);

  return { data, format };
}

/** Read file content with error wrapping */
function readFileSafe(filePath: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is pre-validated by resolveExplicitPath / autoDiscover
    return readFileSync(filePath, "utf-8");
  } catch (cause) {
    throw ConfigurationError.fileReadFailed(filePath, cause instanceof Error ? cause : undefined);
  }
}

/** Parse content based on format */
function parseContent(content: string, format: ConfigFileFormat, filePath: string): Record<string, unknown> {
  try {
    switch (format) {
      case "toml":
        return tomlParse(content);
      case "yaml":
        return parseYamlSafe(content);
      case "json":
        return parseJsonSafe(content);
    }
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw ConfigurationError.fileParseFailed(filePath, cause instanceof Error ? cause : undefined);
  }
}

/**
 * Parse YAML content with type guard.
 *
 * YAML can parse to scalars, arrays, or null — we require a mapping (object).
 */
function parseYamlSafe(content: string): Record<string, unknown> {
  const result: unknown = yamlParse(content);

  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) {
    throw ConfigurationError.fileParseFailed(
      "config",
      new Error("Config file must contain a mapping (object), not a scalar or array"),
    );
  }

  // @type-narrowing — runtime check above validates object type, but TS keeps `unknown`
  return result as Record<string, unknown>;
}

/**
 * Parse JSON content with type guard.
 *
 * `JSON.parse()` can return any JSON value — we require a plain object.
 */
function parseJsonSafe(content: string): Record<string, unknown> {
  const result: unknown = JSON.parse(content);

  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) {
    throw ConfigurationError.fileParseFailed(
      "config",
      new Error("Config file must contain a JSON object, not a scalar or array"),
    );
  }

  // @type-narrowing — runtime check above validates object type, but TS keeps `unknown`
  return result as Record<string, unknown>;
}

// ============================================================================
// Unknown Key Detection
// ============================================================================

/**
 * Known section names derived from the config file schema.
 *
 * This ensures sync with `configFileSchema` — no manual duplication needed.
 */
const KNOWN_SECTIONS: ReadonlySet<string> = Object.freeze(new Set(Object.keys(CONFIG_FILE_SECTIONS)));

/**
 * Known keys per section derived from the section Zod schemas.
 *
 * Introspects each section's `ZodObject.shape` to extract valid key names.
 * Falls back to an empty set for non-object schemas (defensive).
 */
const KNOWN_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CONFIG_FILE_SECTIONS).map(([name, schema]) => {
      const shape = extractShapeKeys(schema);
      return [name, shape];
    }),
  ),
);

/**
 * Extract key names from a Zod schema, handling `.partial()` wrappers.
 */
function extractShapeKeys(schema: z.ZodTypeAny): Set<string> {
  if ("shape" in schema && typeof schema.shape === "object" && schema.shape !== null) {
    // @type-narrowing — runtime check validates shape is a non-null object; Zod exposes shape as untyped
    return new Set(Object.keys(schema.shape as Record<string, unknown>));
  }
  return new Set();
}

/**
 * Detect and warn about unknown keys in the raw config file data.
 *
 * Compares the raw parsed data against known schema keys and registered
 * consumer sections, logging warnings for any unrecognized keys.
 * This catches typos without preventing the server from starting.
 *
 * @param data - Raw parsed config file data
 * @param filePath - Path to the config file (for log context)
 */
function warnUnknownKeys(data: unknown, filePath: string): void {
  if (!data || typeof data !== "object") return;

  // @type-narrowing — runtime guard above ensures data is a non-null object
  const root = data as Record<string, unknown>;
  const consumerSections = getRegisteredSectionNames();

  for (const key of Object.keys(root)) {
    if (KNOWN_SECTIONS.has(key)) {
      const section = root[key];
      if (!section || typeof section !== "object") continue;

      const knownKeys = KNOWN_KEYS[key];
      if (!knownKeys || knownKeys.size === 0) continue;

      // @type-narrowing — section type-checked to be a non-null object above
      for (const sectionKey of Object.keys(section as Record<string, unknown>)) {
        if (!knownKeys.has(sectionKey)) {
          addStartupWarning(`[config] Unknown key '${sectionKey}' in [${key}] section of ${filePath} — ignored`);
        }
      }
      continue;
    }

    if (consumerSections.has(key)) {
      continue;
    }

    addStartupWarning(`[config] Unknown section '${key}' in ${filePath} — ignored`);
  }
}

// ============================================================================
// Consumer Section Processing
// ============================================================================

/**
 * Process registered consumer sections from the raw config file data.
 *
 * For each registered section found in the config file:
 * 1. Validate against the registered Zod schema
 * 2. Store the validated data for retrieval via `getAppConfig()`
 *
 * @param data - Raw parsed config file data
 * @param filePath - Path to the config file (for error context)
 * @throws {ConfigurationError} If a consumer section fails validation
 */
function processConsumerSections(data: unknown, filePath: string): void {
  if (!data || typeof data !== "object") return;

  // @type-narrowing — runtime guard above ensures data is a non-null object
  const root = data as Record<string, unknown>;
  const consumerSections = getRegisteredSectionNames();

  for (const sectionName of consumerSections) {
    const sectionData = root[sectionName];
    if (sectionData === undefined) continue;

    const schema = getRegisteredSectionSchema(sectionName);
    if (!schema) continue;

    const parseResult = schema.safeParse(sectionData);
    if (!parseResult.success) {
      throw ConfigurationError.fileValidationFailed(filePath, parseResult.error);
    }

    setRegisteredSectionData(sectionName, parseResult.data);
  }
}
