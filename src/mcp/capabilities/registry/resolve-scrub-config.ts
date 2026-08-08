/**
 * Declarative scrub configuration resolver.
 *
 * Turns the `MCP_SCRUB_*` environment variables into a {@link ScrubToolResultsConfig},
 * merged with a consumer-provided base — the reusable half of scrub setup, mirroring
 * `resolveAuthConfig()`'s role for auth. Domain-specific rules (`dropKeys`,
 * `sensitivePaths`, `maskWhenSibling`) stay programmatic-only (`base`); only the
 * operator-facing key lists (`additionalKeys`, `allowKeys`) and the master switch are
 * env-configurable.
 *
 * @module mcp/capabilities/registry/resolve-scrub-config
 */

import { getFrameworkConfig } from "../../../config/config-cache.js";
import type { SecretScrubberOptions } from "../../../utils/scrubbing/index.js";
import type { ScrubToolResultsConfig } from "./result-scrub.js";

/**
 * Resolve `MCP_SCRUB_ENABLED` / `MCP_SCRUB_ADDITIONAL_KEYS` / `MCP_SCRUB_ALLOW_KEYS`
 * against a consumer-provided `base` config.
 *
 * Precedence mirrors `resolveAuthConfig()`: `MCP_SCRUB_ENABLED`, when set, wins over
 * `base` outright (12-Factor: env overrides programmatic defaults). `additionalKeys`
 * / `allowKeys` from the environment are **unioned** with `base`'s, never replace them.
 *
 * Resolved once at server bootstrap (same call pattern as `resolveAuthConfig()`) — not
 * meant to be re-invoked mid-session; scrub rules stay immutable for the process
 * lifetime once passed to `createServer()` / `configureDynamicResourceRegistry()`.
 *
 * **Opt-in.** Nothing in the framework calls this for you: a consumer that passes its
 * own config straight to `createServer({ scrubToolResults })` never sees `MCP_SCRUB_*`
 * take effect. Route the config through here to make those variables live.
 *
 * **Caveat when re-enabling.** `base === false` carries no rules, so
 * `MCP_SCRUB_ENABLED=true` on top of it yields the generic heuristics ONLY — the
 * consumer's `dropKeys` / `sensitivePaths` / `maskWhenSibling` are gone, because a
 * disabled base never supplied them. Consumers whose domain rules must survive every
 * combination of switches should compose explicitly rather than rely on this override.
 *
 * @param base - The consumer's programmatic scrub config (e.g. domain `dropKeys` /
 *   `sensitivePaths` rules). Omit for env-only configuration.
 */
export function resolveScrubConfig(base?: ScrubToolResultsConfig): ScrubToolResultsConfig {
  const env = getFrameworkConfig();
  const enabled = env.MCP_SCRUB_ENABLED ?? base !== false;
  if (!enabled) return false;

  const baseOptions: SecretScrubberOptions = typeof base === "object" ? base : {};
  const additionalKeys = [...(env.MCP_SCRUB_ADDITIONAL_KEYS ?? []), ...(baseOptions.additionalKeys ?? [])];
  const allowKeys = [...(env.MCP_SCRUB_ALLOW_KEYS ?? []), ...(baseOptions.allowKeys ?? [])];

  return {
    ...baseOptions,
    ...(additionalKeys.length > 0 && { additionalKeys }),
    ...(allowKeys.length > 0 && { allowKeys }),
  };
}
