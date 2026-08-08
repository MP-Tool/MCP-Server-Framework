/**
 * TOML-aware secret scrubbing.
 *
 * TOML is a STRUCTURED format that arrives as a string. Handing it to the flat
 * text scrub loses every declarative rule — `dropKeys`, `sensitivePaths` and
 * `maskWhenSibling` all need real object structure — while the `key=value`
 * regex simultaneously over-redacts allowlisted keys (`is_secret = true`
 * becomes a masked string and the document stops parsing). So TOML is scrubbed
 * AS AN OBJECT, exactly like JSON in {@link scrubByMimeType}.
 *
 * Lives in its own module so `secret-scrubber.ts` keeps its zero-dependency
 * footprint — the engine stays a pure primitive, the format adapter owns the
 * parser dependency.
 *
 * @module utils/scrubbing/scrub-toml
 */

import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";
import type { SecretScrubber } from "./secret-scrubber.js";

/**
 * Scrub TOML content structurally: parse → {@link SecretScrubber.scrubObject} →
 * re-serialize.
 *
 * Round-tripping normalizes formatting and drops comments — acceptable for a
 * redacted document, which is for inspection rather than byte-exact replay.
 * `TomlDate` values survive: they extend `Date`, which the scrubber hands back
 * untouched.
 *
 * Fails soft, mirroring the JSON branch: content that does not parse as TOML
 * (or that re-serialization rejects) falls back to the text scrub, so a
 * mislabelled payload is still redacted on a best-effort basis rather than
 * passed through raw.
 *
 * @param content - The TOML document
 * @param scrubber - The configured scrubber supplying the redaction policy
 * @returns Redacted TOML, or text-scrubbed content when parsing fails
 */
export function scrubTomlContent(content: string, scrubber: SecretScrubber): string {
  try {
    return tomlStringify(scrubber.scrubObject(tomlParse(content)) as Parameters<typeof tomlStringify>[0]);
  } catch {
    // Declared TOML but doesn't parse (or won't re-serialize) — treat as text.
    return scrubber.scrub(content);
  }
}
