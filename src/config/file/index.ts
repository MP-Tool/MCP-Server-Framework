/**
 * Config File Module Barrel Export
 *
 * @module config/file
 */

// Loader (main entry point)
export { loadConfigFile } from "./loader.js";

// Schema, types & constants
export {
  configFileSchema,
  CONFIG_FILE_SECTIONS,
  mapConfigToEnvKeys,
  CONFIG_FILE_ENV_VAR,
  DISCOVERY_FILENAMES,
  type ConfigFileData,
  type ConfigFileFormat,
  type ConfigFileResult,
  type ConfigSource,
} from "./schema.js";
