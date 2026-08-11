/**
 * Scrubbing Module
 *
 * Generic secret-detection/redaction engine (see `secret-scrubber.ts` for the
 * module doc). Reused by the logger's own output-sanitization pipeline and by
 * multiple `mcp/capabilities/` consumers.
 *
 * @module utils/scrubbing
 */

export {
  SecretScrubber,
  secretScrubber,
  createSecretScrubber,
  scrubByMimeType,
  REDACTED_VALUE,
} from "./secret-scrubber.js";
export type { SecretScrubberOptions, SecretScrubberConfig } from "./secret-scrubber.js";
export { scrubTomlContent } from "./scrub-toml.js";
