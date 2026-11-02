/**
 * Dynamic Resource Registry
 *
 * Stores ephemeral, session-bound resources at runtime and exposes them through
 * a single resource template. Tools register large payloads (logs, inspect output,
 * config dumps) here and return only the `ephemeral://…` URI to the client; the
 * client may follow up with `resources/read` to fetch the full content.
 *
 * Design contract:
 * - **Strict session-binding**: `read()` requires the caller's `sessionId` to
 *   match the registering session. Cross-session reads throw a 403.
 * - **TTL eviction**: Each entry has an absolute `expiresAt` timestamp; expired
 *   entries are pruned by a periodic cleanup interval and on every `read()`.
 * - **Fair cap**: When `maxEntries` is reached, expired entries go first, then the oldest
 *   entry of the session holding the most, so one session cannot push out another's.
 * - **Cryptographic IDs**: 16 random bytes (128 bits) → 32-hex-char id, generated
 *   via `crypto.randomBytes`. Collision probability is negligible at the configured
 *   capacity.
 *
 * @module mcp/capabilities/resources/dynamic/dynamic-resource-registry
 */

import { randomBytes } from "node:crypto";

import { FrameworkErrorFactory } from "../../../../errors/index.js";
import { logger as baseLogger } from "../../../../logger/index.js";
import { createSecretScrubber, scrubByMimeType } from "../../../../utils/scrubbing/index.js";
import type { SecretScrubber, SecretScrubberConfig } from "../../../../utils/scrubbing/index.js";

const logger = baseLogger.child({ component: "dynamic-resource-registry" });

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_URI_SCHEME = "ephemeral";
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const ID_BYTES = 16;
const CATEGORY_PATTERN = /^[a-z0-9_-]+$/i;

// ============================================================================
// Types
// ============================================================================

/**
 * Stored entry in the dynamic resource registry.
 */
export interface DynamicResourceEntry {
  /** Generated `ephemeral://<category>/<id>` URI */
  readonly uri: string;
  /** Session ID that owns this entry (strict-binding key) */
  readonly sessionId: string;
  /** URI category segment (e.g. `logs`, `info`) */
  readonly category: string;
  /** MIME type of the stored content */
  readonly mimeType: string;
  /** Stored payload */
  readonly content: string | Uint8Array;
  /** Creation timestamp (ms since epoch) */
  readonly createdAt: number;
  /** Expiration timestamp (ms since epoch) */
  readonly expiresAt: number;
}

/**
 * Options for `DynamicResourceRegistry`.
 */
export interface DynamicResourceRegistryOptions {
  /** URI scheme for generated URIs (default: `ephemeral`) */
  readonly uriScheme?: string;
  /** Maximum entries; past it, the session holding the most loses its oldest (default: 1000) */
  readonly maxEntries?: number;
  /** Default TTL in ms when `register()` omits `ttlMs` (default: 5 min) */
  readonly defaultTtlMs?: number;
  /** Cleanup interval in ms (default: 60 s; set to 0 to disable) */
  readonly cleanupIntervalMs?: number;
  /**
   * Secret scrubbing for registered content (**default ON**). Offloaded
   * resources bypass the tool-result scrub boundary — they are served later
   * via `resources/read` — so string content is scrubbed on register instead
   * (secrets never sit in the store). `Uint8Array` content passes through
   * verbatim. `false` disables; an options object extends/exempts keys.
   */
  readonly scrub?: SecretScrubberConfig;
}

/**
 * Arguments for `DynamicResourceRegistry.register()`.
 */
export interface RegisterDynamicResourceOptions {
  /** Owning session ID — strict-binding key */
  readonly sessionId: string;
  /** URI category segment (a-z, 0-9, `_`, `-`) */
  readonly category: string;
  /** MIME type of the content */
  readonly mimeType: string;
  /** Payload to store */
  readonly content: string | Uint8Array;
  /** TTL override in ms (defaults to `defaultTtlMs`) */
  readonly ttlMs?: number;
}

/**
 * Result returned by `DynamicResourceRegistry.register()`.
 */
export interface RegisterDynamicResourceResult {
  /** Generated `ephemeral://…` URI */
  readonly uri: string;
  /** Absolute expiration timestamp (ms since epoch) */
  readonly expiresAt: number;
}

/**
 * Result returned by `DynamicResourceRegistry.read()`.
 */
export interface ReadDynamicResourceResult {
  /** Stored payload */
  readonly content: string | Uint8Array;
  /** MIME type of the payload */
  readonly mimeType: string;
}

// ============================================================================
// Registry
// ============================================================================

/**
 * In-memory store for ephemeral, session-bound resources.
 *
 * Use through {@link getDynamicResourceRegistry} (singleton) for the default
 * configuration, or construct directly for custom scopes (testing, multi-tenant).
 */
export class DynamicResourceRegistry {
  private readonly entries = new Map<string, DynamicResourceEntry>();
  private readonly uriSchemeValue: string;
  private readonly maxEntriesValue: number;
  private readonly defaultTtlMsValue: number;
  private readonly cleanupIntervalMsValue: number;
  private readonly scrubber: SecretScrubber | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options?: DynamicResourceRegistryOptions) {
    this.uriSchemeValue = options?.uriScheme ?? DEFAULT_URI_SCHEME;
    this.maxEntriesValue = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtlMsValue = options?.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.cleanupIntervalMsValue = options?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.scrubber = createSecretScrubber(options?.scrub);
  }

  /** URI scheme used for generated URIs (e.g. `ephemeral`) */
  get uriScheme(): string {
    return this.uriSchemeValue;
  }

  /** Current number of stored entries */
  get size(): number {
    return this.entries.size;
  }

  /** Maximum entries before eviction */
  get maxEntries(): number {
    return this.maxEntriesValue;
  }

  /**
   * Register an ephemeral resource. Returns the generated URI and absolute
   * expiration timestamp.
   *
   * @throws ValidationError if `sessionId` is empty or `category` is invalid.
   */
  register(options: RegisterDynamicResourceOptions): RegisterDynamicResourceResult {
    if (!options.sessionId) {
      throw FrameworkErrorFactory.validation.fieldRequired("sessionId");
    }
    if (!options.category || !CATEGORY_PATTERN.test(options.category)) {
      throw FrameworkErrorFactory.validation.fieldInvalid("category", options.category);
    }
    if (!options.mimeType) {
      throw FrameworkErrorFactory.validation.fieldRequired("mimeType");
    }

    this.makeRoom();

    const id = randomBytes(ID_BYTES).toString("hex");
    const uri = `${this.uriSchemeValue}://${options.category}/${id}`;
    const now = Date.now();
    const ttl = options.ttlMs ?? this.defaultTtlMsValue;
    // Scrub-on-register: offloaded content bypasses the tool-result boundary,
    // so redact here — secrets never sit in the store. Errors propagate
    // (fail-closed: the caller falls back to inlining, which IS boundary-scrubbed).
    const content =
      this.scrubber && typeof options.content === "string"
        ? scrubByMimeType(options.content, options.mimeType, this.scrubber)
        : options.content;
    const entry: DynamicResourceEntry = {
      uri,
      sessionId: options.sessionId,
      category: options.category,
      mimeType: options.mimeType,
      content,
      createdAt: now,
      expiresAt: now + ttl,
    };
    this.entries.set(uri, entry);
    this.startCleanupIfNeeded();

    logger.trace("Registered dynamic resource: %s (sessionId=%s, ttlMs=%d)", uri, options.sessionId, ttl);
    return { uri, expiresAt: entry.expiresAt };
  }

  /**
   * Read an ephemeral resource. Strict session-binding: the caller's
   * `sessionId` MUST match the registering session.
   *
   * @throws AuthorizationError (403) on cross-session access.
   * @throws RegistryError (resource not found) when the URI is unknown or expired.
   */
  read(uri: string, callerSessionId: string | undefined): ReadDynamicResourceResult {
    const entry = this.entries.get(uri);

    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) {
        this.entries.delete(uri);
      }
      throw FrameworkErrorFactory.registry.resourceNotFound(uri);
    }

    if (entry.sessionId !== callerSessionId) {
      logger.warn(
        "Cross-session read denied for dynamic resource: %s (owner=%s, caller=%s)",
        uri,
        entry.sessionId,
        callerSessionId ?? "<none>",
      );
      throw FrameworkErrorFactory.auth.forbidden("Cross-session access to dynamic resource is not permitted");
    }

    return { content: entry.content, mimeType: entry.mimeType };
  }

  /**
   * Remove all entries owned by the given session. Returns the number of
   * removed entries. Called automatically on session disconnect.
   */
  unregisterBySession(sessionId: string): number {
    let removed = 0;
    for (const [uri, entry] of this.entries) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(uri);
        removed++;
      }
    }
    if (removed > 0) {
      logger.trace("Cleared %d dynamic resources for session %s", removed, sessionId);
    }
    return removed;
  }

  /**
   * Remove all entries that have expired. Returns the number of removed entries.
   * Invoked periodically by the cleanup timer.
   */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [uri, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(uri);
        removed++;
      }
    }
    return removed;
  }

  /** Remove all entries and stop the cleanup timer. Used by tests and shutdown. */
  clear(): void {
    this.entries.clear();
    this.stopCleanup();
  }

  /** Start the cleanup timer eagerly (otherwise started on first `register()`). */
  start(): void {
    this.startCleanupIfNeeded();
  }

  /** Stop the cleanup timer. Safe to call multiple times. */
  stop(): void {
    this.stopCleanup();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Eviction
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * At the cap, frees expired entries, else the oldest entry of the session holding the most.
   * The store is shared, so a global FIFO would let one session push out the others' resources.
   */
  private makeRoom(): void {
    if (this.entries.size < this.maxEntriesValue || this.cleanupExpired() > 0) return;

    const counts = new Map<string, number>();
    let largest: string | undefined;
    for (const { sessionId } of this.entries.values()) {
      const count = (counts.get(sessionId) ?? 0) + 1;
      counts.set(sessionId, count);
      if (largest === undefined || count > (counts.get(largest) ?? 0)) largest = sessionId;
    }

    // Map iteration order = insertion order, so the first match is that session's oldest.
    for (const [uri, entry] of this.entries) {
      if (entry.sessionId === largest) {
        this.entries.delete(uri);
        logger.debug("Evicted oldest dynamic resource of the largest session (cap reached): %s", uri);
        return;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  private startCleanupIfNeeded(): void {
    if (this.cleanupTimer || this.cleanupIntervalMsValue <= 0) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanupExpired();
      if (removed > 0) {
        logger.trace("Cleaned up %d expired dynamic resources", removed);
      }
    }, this.cleanupIntervalMsValue);
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  private stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

// ============================================================================
// Singleton Accessors
// ============================================================================

let globalRegistry: DynamicResourceRegistry | undefined;

/**
 * Returns the process-wide singleton instance, creating it on first access
 * with default options.
 */
export function getDynamicResourceRegistry(): DynamicResourceRegistry {
  if (!globalRegistry) {
    globalRegistry = new DynamicResourceRegistry();
  }
  return globalRegistry;
}

/**
 * Replaces the singleton with a freshly configured instance. Existing entries
 * are dropped and the previous timer is stopped. Call this once during server
 * startup if you need non-default options (TTL, cap, scheme).
 */
export function configureDynamicResourceRegistry(options: DynamicResourceRegistryOptions): DynamicResourceRegistry {
  if (globalRegistry) {
    globalRegistry.clear();
  }
  globalRegistry = new DynamicResourceRegistry(options);
  return globalRegistry;
}

/**
 * Drops the singleton (test helper). Subsequent calls to
 * `getDynamicResourceRegistry()` will create a new instance.
 */
export function resetDynamicResourceRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear();
  }
  globalRegistry = undefined;
}
