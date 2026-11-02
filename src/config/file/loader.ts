/**
 * Config File Loader
 *
 * Orchestrates the config file loading pipeline:
 * 1. Discover config file (explicit path or auto-discovery)
 * 2. Parse raw content (TOML, YAML, or JSON)
 * 3. Validate: unknown sections and keys, invalid values
 * 4. Map nested structure to flat `FrameworkEnvConfig` overrides
 *
 * A file that fails any of this is a config error and is never used in part: a file found
 * by auto-discovery may not be ours (MP-Tool/komodo-mcp-server#191), so it is discarded with a
 * logged error and the server starts without it. A file named by `MCP_CONFIG_FILE_PATH` is
 * what the operator asked for, so it aborts the start. So does a discovered file that sets
 * `[auth]` or `[security]`: starting without those could leave the server unprotected.
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
import { ConfigurationError } from "../../errors/categories/validation.js";
import { formatZodIssues } from "../../utils/zod-helpers.js";
import { addStartupError, addStartupWarning } from "../startup-messages.js";
import { getRegisteredSectionNames, getRegisteredSectionSchema, setRegisteredSectionData } from "../extensions.js";
import {
  configFileSchema,
  CONFIG_FILE_SECTIONS,
  mapConfigToOverrides,
  CONFIG_FILE_ENV_VAR,
  DISCOVERY_FILENAMES,
  EXTENSION_FORMAT_MAP,
} from "./schema.js";
import type { ConfigFileData, ConfigFileFormat, ConfigFileResult } from "./schema.js";

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
 * Consumer sections are only stored once the whole file passed, so a discarded file leaves
 * nothing behind.
 *
 * @returns Config file result with overrides and metadata, or `undefined` if no file was found
 *   or a discovered file was discarded
 * @throws {ConfigurationError} If an invalid file cannot be discarded (see the module comment)
 */
export function loadConfigFile(): ConfigFileResult | undefined {
  const found = discoverConfigFile();
  if (!found) {
    return undefined;
  }

  const validation = validateConfigFile(found.path);
  const discardable = found.discovered && !validation.setsSecuritySections;
  if ("findings" in validation) {
    if (!discardable) {
      throw ConfigurationError.invalidFile(found.path, validation.findings, { discovered: found.discovered });
    }
    reportIgnoredConfigFile(found.path, validation.findings);
    return undefined;
  }

  const { format, data, overrides, consumerSections } = validation;
  for (const [name, sectionData] of consumerSections) {
    setRegisteredSectionData(name, sectionData);
  }

  // Retain the nested [auth] section — its `providers` table cannot be flattened
  // into env-style overrides, so resolveAuthConfig() reads it from here.
  return { overrides, sourcePath: found.path, discardable, format, rawAuth: data.auth };
}

/**
 * Report a discovered config file that is not used at all.
 *
 * @param filePath - Path of the discarded file
 * @param findings - Everything wrong with it, one entry per problem
 * @internal
 */
export function reportIgnoredConfigFile(filePath: string, findings: readonly string[]): void {
  addStartupError(
    `[config] Ignoring auto-discovered config file ${filePath}, starting with environment variables and ` +
      `defaults only. It is invalid, or not meant for this server. To use a config file on purpose, set ` +
      `${CONFIG_FILE_ENV_VAR}; an invalid file then stops the start.`,
  );
  for (const finding of findings) {
    addStartupError(`[config] ${filePath}: ${finding}`);
  }
}

// ============================================================================
// Validation
// ============================================================================

/** Sections whose loss could leave a server unprotected. */
const SECURITY_SECTIONS = ["auth", "security"];

/**
 * The same question for a file that does not parse, so it can only be read as text: broad on
 * purpose, as a false match stops a start and a miss could leave a server open.
 */
const SECURITY_SECTIONS_IN_TEXT = /^\s*(?:\[\s*)?(?:auth|security)\b|"(?:auth|security)"\s*:/m;

/** A config file that failed its checks. */
interface InvalidConfigFile {
  readonly findings: readonly string[];
  readonly setsSecuritySections: boolean;
}

/** A config file that passed all checks. Nothing from it has been applied yet. */
interface ValidatedConfigFile {
  readonly setsSecuritySections: boolean;
  readonly format: ConfigFileFormat;
  readonly data: ConfigFileData;
  readonly overrides: ConfigFileResult["overrides"];
  readonly consumerSections: ReadonlyMap<string, unknown>;
}

/**
 * Run all checks on a config file and collect every problem, so that one pass over the
 * file fixes it.
 */
function validateConfigFile(filePath: string): ValidatedConfigFile | InvalidConfigFile {
  let content: string;
  try {
    content = readFileSafe(filePath);
  } catch (error) {
    return { findings: [describeParseFailure(error)], setsSecuritySections: false };
  }

  let parsed: ReturnType<typeof parseConfigFile>;
  try {
    parsed = parseConfigFile(filePath, content);
  } catch (error) {
    return { findings: [describeParseFailure(error)], setsSecuritySections: SECURITY_SECTIONS_IN_TEXT.test(content) };
  }

  const root = parsed.data;
  const setsSecuritySections = SECURITY_SECTIONS.some((section) => Object.hasOwn(root, section));
  const findings = findUnknownSections(root);

  const frameworkResult = configFileSchema.safeParse(parsed.data);
  if (!frameworkResult.success) {
    findings.push(...formatZodIssues(frameworkResult.error));
  }

  const consumerSections = new Map<string, unknown>();
  for (const name of getRegisteredSectionNames()) {
    const sectionData = parsed.data[name];
    const schema = getRegisteredSectionSchema(name);
    if (sectionData === undefined || !schema) continue;

    const sectionResult = schema.safeParse(sectionData);
    if (sectionResult.success) {
      consumerSections.set(name, sectionResult.data);
    } else {
      findings.push(...formatZodIssues(sectionResult.error, { section: name }));
    }
  }

  if (!frameworkResult.success || findings.length > 0) {
    return { findings, setsSecuritySections };
  }

  try {
    return {
      setsSecuritySections,
      format: parsed.format,
      data: frameworkResult.data,
      overrides: mapConfigToOverrides(frameworkResult.data),
      consumerSections,
    };
  } catch (error) {
    return { findings: [error instanceof Error ? error.message : String(error)], setsSecuritySections };
  }
}

/**
 * Describe why a file could not be read or parsed. Parsers quote the surrounding lines of the
 * file below their first line, and `JSON.parse` quotes the start of the input. Those can hold
 * secrets, and this text ends up in logs.
 */
function describeParseFailure(error: unknown): string {
  const cause = error instanceof ConfigurationError && error.cause instanceof Error ? error.cause : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("is not valid JSON") ? "Not valid JSON" : (message.split("\n", 1)[0] ?? message);
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
 * @returns Absolute path to the config file and how it was found, or `undefined` if none found
 * @throws {ConfigurationError} If the explicit path has an unsupported extension
 */
function discoverConfigFile(): { readonly path: string; readonly discovered: boolean } | undefined {
  const explicitPath = process.env[CONFIG_FILE_ENV_VAR];
  const path = explicitPath ? resolveExplicitPath(explicitPath) : autoDiscover();

  return path === undefined ? undefined : { path, discovered: !explicitPath };
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
 * @param content - The file's text
 * @returns Parsed raw object and detected format
 * @throws {ConfigurationError} On unsupported format or parse failures
 */
function parseConfigFile(
  filePath: string,
  content: string,
): {
  data: Record<string, unknown>;
  format: ConfigFileFormat;
} {
  const ext = extname(filePath).toLowerCase();
  const format = EXTENSION_FORMAT_MAP[ext];

  if (!format) {
    throw ConfigurationError.unsupportedFormat(ext);
  }

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
// Unknown Section Detection
// ============================================================================

/**
 * Known section names derived from the config file schema.
 *
 * This ensures sync with `configFileSchema` — no manual duplication needed.
 */
const KNOWN_SECTIONS: ReadonlySet<string> = new Set(Object.keys(CONFIG_FILE_SECTIONS));

/**
 * Find sections that neither the framework nor a registered consumer knows. Unknown keys inside
 * a known section are reported by its own strict schema.
 *
 * @param root - Raw parsed config file data
 * @returns One finding per unknown section
 */
function findUnknownSections(root: Record<string, unknown>): string[] {
  const consumerSections = getRegisteredSectionNames();
  return Object.keys(root)
    .filter((name) => !KNOWN_SECTIONS.has(name) && !consumerSections.has(name))
    .map((name) => `Unknown section '${name}'`);
}
