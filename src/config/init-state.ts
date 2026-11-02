/**
 * Config Initialization State
 *
 * Whether the framework config has been loaded. On its own so that `extensions.ts` can guard
 * against late registration without importing `config-cache.ts`, which loads the file loader,
 * which needs `extensions.ts`.
 *
 * @module config/init-state
 */

let initialized = false;

/**
 * Record that the framework config has been loaded.
 *
 * @internal
 */
export function markConfigInitialized(): void {
  initialized = true;
}

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
  return initialized;
}
