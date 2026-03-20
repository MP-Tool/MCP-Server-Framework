/**
 * Framework Config Cache
 *
 * Provides a cached, lazily-initialized accessor for the parsed
 * framework environment configuration. Single source of truth —
 * all modules delegate to this cache instead of caching locally.
 *
 * Config sources are applied in 12-Factor priority order (highest wins):
 * 1. Defaults (from Zod schema)
 * 2. `.env` file (parsed via `dotenv.parse()` — no `process.env` mutation)
 * 3. Config file (config.toml / config.yaml / config.yml / config.json)
 * 4. Environment variables (`process.env`)
 * 5. Programmatic overrides (via `applyConfigOverrides()`)
 *
 * This follows the 12-Factor App methodology: environment variables
 * always override config file values, enabling per-deploy overrides
 * without touching configuration files.
 *
 * Derived caches in middleware (DNS rebinding, rate limiter) register
 * their reset functions so `resetConfigCache()` invalidates everything.
 *
 * @module config/config-cache
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { parseFrameworkEnv, validateConfigConstraints, type FrameworkEnvConfig } from "./env.js";
import { resetConfigExtensions } from "./extensions.js";
import { loadConfigFile, mapConfigToEnvKeys, type ConfigSource } from "./file/index.js";
import { addStartupWarning, resetStartupWarnings } from "./startup-warnings.js";
import { ConfigurationError } from "../errors/categories/validation.js";
// ============================================================================
// Deferred Logger (injected after logger initialization)
// ============================================================================

const LogMessages = {
  INITIALIZED: "Configuration initialized (source: %s)",
  INITIALIZED_FILE: "Configuration initialized from %s (%s format)",
  DOTENV_LOADED: ".env file loaded: %d variable(s)",
  DOTENV_NOT_FOUND: "No .env file found — using environment variables only",
  CONFIG_FILE_DETECTED: "Config file detected: %s (format: %s)",
  OVERRIDES_APPLIED: "Programmatic config overrides applied (%d key(s))",
  CACHE_RESET: "Config cache reset (including %d satellite caches)",
} as const;

/**
 * Minimal logger interface for config module.
 * Avoids direct dependency on the framework logger.
 */
interface ConfigLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** Noop logger used before the real logger is injected */
const noopLogger: ConfigLogger = {
  debug: () => {},
  info: () => {},
};

/** Injected logger instance */
let logger: ConfigLogger = noopLogger;

/**
 * Inject the framework logger into the config module.
 *
 * Called once during server startup after the logger is initialized.
 * Before injection, log calls are silently dropped (startup-critical
 * warnings use `addStartupWarning()` which writes to stderr immediately).
 *
 * @param injectedLogger - A ConfigLogger instance (caller creates child logger)
 * @internal
 */
export function setConfigLogger(injectedLogger: ConfigLogger): void {
  logger = injectedLogger;
}

// ============================================================================
// Cached Config
// ============================================================================

/** Cached config instance (lazy initialization) */
let cachedConfig: FrameworkEnvConfig | undefined;

/** Metadata about how the config was loaded */
let configSource: ConfigSource | undefined;

/** Registered satellite cache reset functions */
const satelliteResets: Array<() => void> = [];

/**
 * Check whether the framework config has been initialized.
 *
 * Used by the extensions module to guard against late registration
 * of config sections after config loading is complete.
 *
 * @returns `true` if `getFrameworkConfig()` has been called at least once
 * @internal
 */
export function isConfigInitialized(): boolean {
  return cachedConfig !== undefined;
}

/**
 * Returns the parsed framework environment configuration.
 *
 * The config is lazily initialized on first access and cached
 * for the lifetime of the process. This avoids re-parsing
 * environment variables on every request.
 *
 * On first call, the initialization sequence is:
 * 1. Parse environment variables (defaults + env)
 * 2. Discover and load config file (if present)
 * 3. Merge config file and overrides env config
 * 4. Validate cross-field constraints on merged result
 *
 * @returns Parsed and validated framework environment configuration
 */
export function getFrameworkConfig(): Readonly<FrameworkEnvConfig> {
  if (!cachedConfig) {
    cachedConfig = Object.freeze(initializeConfig());
  }
  return cachedConfig;
}

/**
 * Returns metadata about which config source is active.
 *
 * Useful for logging after the logger is initialized.
 * Returns `undefined` if the config hasn't been loaded yet.
 */
export function getConfigSource(): ConfigSource | undefined {
  return configSource;
}

/**
 * Registers a satellite cache reset function.
 *
 * Modules that derive cached values from the framework config
 * (e.g., allowed hosts list, rate limiter instance) register their
 * reset functions here so `resetConfigCache()` can invalidate them.
 *
 * @param resetFn - Function that clears the satellite cache
 * @internal
 */
export function registerCacheReset(resetFn: () => void): void {
  if (!satelliteResets.includes(resetFn)) {
    satelliteResets.push(resetFn);
  }
}

/**
 * Resets the framework config cache and all registered satellite caches.
 *
 * Intended for testing — forces re-parsing of environment
 * variables on the next `getFrameworkConfig()` call and
 * invalidates all derived caches.
 *
 * @internal
 */
export function resetConfigCache(): void {
  cachedConfig = undefined;
  configSource = undefined;
  resetConfigExtensions();
  resetStartupWarnings();
  for (const reset of satelliteResets) {
    reset();
  }
  logger.debug(LogMessages.CACHE_RESET, satelliteResets.length);
}

/**
 * Applies programmatic overrides to the framework configuration cache.
 *
 * This bridges the gap between programmatic `createServer()` options and
 * the environment-based framework configuration. Called early in the server
 * startup sequence (before transport creation) to ensure all downstream
 * modules see consistent configuration.
 *
 * Only non-undefined values are applied — environment variables remain
 * the default source for any unspecified options.
 *
 * Automatically invalidates satellite caches (rate limiter, DNS rebinding, etc.)
 * since the underlying config has changed.
 *
 * After merging, cross-field constraints are re-validated to catch
 * invalid combinations (e.g., HTTPS mode without TLS paths).
 *
 * @param overrides - Partial config to merge into the cached configuration
 */
export function applyConfigOverrides(overrides: Partial<FrameworkEnvConfig>): void {
  // Ensure base config is initialized from environment + config file
  const base = getFrameworkConfig();

  const merged = mergeConfigValues(base, overrides);

  // Re-validate cross-field constraints after merge
  validateMergedConfig(merged);

  cachedConfig = Object.freeze(merged);

  // Invalidate derived caches since underlying config changed
  for (const reset of satelliteResets) {
    reset();
  }

  const overrideCount = Object.values(overrides).filter((v) => v !== undefined).length;
  logger.debug(LogMessages.OVERRIDES_APPLIED, overrideCount);
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the framework config from all sources.
 *
 * 12-Factor Priority: Defaults → .env → Config File → env vars
 * (Programmatic overrides come later via `applyConfigOverrides()`)
 *
 * The `.env` file is read and parsed without mutating `process.env`.
 * Config file values are serialized back to string key-value pairs
 * and merged into the env source so that `process.env` always wins.
 *
 * This single-pass approach ensures Zod coercion (string → number,
 * string → boolean) happens exactly once, on the final merged source.
 */
function initializeConfig(): FrameworkEnvConfig {
  // Step 1: Read .env file into a plain object (no process.env mutation)
  const dotenvValues = loadDotenvFile();

  // Step 2: Try loading a config file
  const fileResult = loadConfigFile();
  if (fileResult) {
    logger.debug(LogMessages.CONFIG_FILE_DETECTED, fileResult.sourcePath, fileResult.format);
  }

  // Step 3: Build merged env source in 12-Factor priority order:
  //   .env (lowest) → config file → process.env (highest)
  const fileEnvKeys = fileResult ? mapConfigToEnvKeys(fileResult.overrides) : {};
  const envSource = { ...dotenvValues, ...fileEnvKeys, ...process.env };

  // Step 4: Parse merged source through Zod schema (single pass)
  const config = parseFrameworkEnv(envSource);

  // Step 5: Validate cross-field constraints
  if (fileResult) {
    validateMergedConfig(config);
  }

  // Step 6: Record which config source is active
  configSource = fileResult
    ? {
        type: "file",
        path: fileResult.sourcePath,
        format: fileResult.format,
        dotenvLoaded: Object.keys(dotenvValues).length > 0,
      }
    : { type: "env", dotenvLoaded: Object.keys(dotenvValues).length > 0 };

  // Log the initialization result
  if (fileResult) {
    logger.info(LogMessages.INITIALIZED_FILE, fileResult.sourcePath, fileResult.format);
  } else {
    logger.info(LogMessages.INITIALIZED, "environment");
  }

  return config;
}

// ============================================================================
// dotenv Loader (Side-Effect-Free)
// ============================================================================

/**
 * Read and parse a `.env` file without mutating `process.env`.
 *
 * Uses `dotenv.parse()` (pure function) instead of `dotenv.config()`
 * to avoid global side effects. The returned object is merged with
 * `process.env` by the caller, ensuring real env vars always win.
 *
 * Silently returns an empty object when no `.env` file exists —
 * this is the normal case in Docker / CI environments.
 *
 * Security:
 * - Only reads `.env` in `process.cwd()` (no directory traversal)
 * - `.env` files should not be committed to version control
 *
 * @returns Parsed key-value pairs from the `.env` file, or empty object
 */
function loadDotenvFile(): Record<string, string> {
  const dotenvPath = join(process.cwd(), ".env");

  if (!existsSync(dotenvPath)) {
    logger.debug(LogMessages.DOTENV_NOT_FOUND);
    return {};
  }

  try {
    const content = readFileSync(dotenvPath, "utf-8");
    const parsed = parseDotenv(content);
    logger.debug(LogMessages.DOTENV_LOADED, Object.keys(parsed).length);
    return parsed;
  } catch {
    // .env exists but can't be read (e.g., permission denied)
    addStartupWarning(`[config] .env file at ${dotenvPath} exists but could not be read — skipping`);
    return {};
  }
}

/**
 * Merges override values into a base config.
 *
 * Only non-undefined values from the overrides are applied.
 * Uses dynamic key access because the override source (env, file,
 * programmatic) is not statically known at compile time.
 *
 * @param base - The base configuration to merge into
 * @param overrides - Partial overrides to apply
 * @returns Merged configuration
 *
 * @type-narrowing Dynamic key iteration requires `Record<string, unknown>` cast
 * because `Object.entries()` erases the key type to `string`. The merged
 * result is typed as `FrameworkEnvConfig` — callers must only pass valid keys.
 */
function mergeConfigValues(base: FrameworkEnvConfig, overrides: Partial<FrameworkEnvConfig>): FrameworkEnvConfig {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      // @type-narrowing — Object.entries() erases key type; override keys are
      // constrained by Partial<FrameworkEnvConfig> at the call site.
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * Validate cross-field constraints on a merged configuration.
 *
 * @throws {ConfigurationError} If constraints are violated
 */
function validateMergedConfig(config: FrameworkEnvConfig): void {
  const violations = validateConfigConstraints(config);
  if (violations.length > 0) {
    const fields = violations.flatMap((v) => [...v.path]);
    const messages = violations.map((v) => v.message).join("; ");
    throw ConfigurationError.constraintViolation(messages, fields);
  }
}
