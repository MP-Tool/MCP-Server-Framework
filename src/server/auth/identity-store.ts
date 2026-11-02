/**
 * Identity-scoped value store.
 *
 * A generic get-or-create cache keyed by a stable identity (a user / principal). It lets an
 * MCP server bind per-user state — most commonly a downstream service connection — and reuse
 * it across requests **in both stateful and stateless transports**:
 *
 * - **Stateful:** resolve once per session, evict promptly on disconnect via {@link IdentityStore.evict}.
 * - **Stateless:** there is no session, so the same `getOrCreate` keyed by identity transparently
 *   reuses an entry across independent requests; idle entries fall out via TTL / LRU.
 *
 * Concurrent `getOrCreate` calls for the same key share a single in-flight factory (no
 * duplicate connections under load). Eviction, TTL expiry, LRU overflow, and `clear()` all run
 * the optional `onDispose` so resources (sockets, timers) are released deterministically.
 *
 * @module server/auth/identity-store
 */

/** Stable per-user store of `T` (e.g. a downstream client/connection). */
export interface IdentityStore<T> {
  /**
   * Returns the value for `key`, creating it via `factory` on a miss. Concurrent calls for the
   * same key await one shared factory invocation. A rejected factory is not cached.
   */
  getOrCreate(key: string, factory: () => Promise<T> | T): Promise<T>;
  /** Returns the value for `key` if present and unexpired, else `undefined`. Does not create. */
  get(key: string): T | undefined;
  /** Whether a live (unexpired) value exists for `key`. */
  has(key: string): boolean;
  /** Removes and disposes the value for `key` (no-op if absent). */
  evict(key: string): void;
  /** Removes and disposes every entry. */
  clear(): void;
  /** Number of resolved entries currently held. */
  readonly size: number;
}

/** Options for {@link createIdentityStore}. */
export interface IdentityStoreOptions<T> {
  /** Idle time-to-live in ms; an entry unused for longer is treated as a miss and disposed. Omit to disable. */
  readonly ttlMs?: number | undefined;
  /** Maximum entries; least-recently-used entries are evicted past this cap. Omit for unbounded. */
  readonly maxEntries?: number | undefined;
  /** Called when an entry is removed (evict, TTL expiry, LRU overflow, clear). Must not throw. */
  readonly onDispose?: ((value: T, key: string) => void) | undefined;
}

interface Entry<T> {
  value?: T | undefined;
  pending?: Promise<T> | undefined;
  lastAccess: number;
}

/**
 * Creates an {@link IdentityStore}.
 *
 * @param options - TTL, LRU cap, and dispose hook
 * @returns A new identity-scoped store
 */
export function createIdentityStore<T>(options?: IdentityStoreOptions<T>): IdentityStore<T> {
  const ttlMs = options?.ttlMs;
  const maxEntries = options?.maxEntries;
  const onDispose = options?.onDispose;

  // Map preserves insertion order — used as the LRU recency list (oldest first).
  const entries = new Map<string, Entry<T>>();

  function dispose(key: string, entry: Entry<T>): void {
    if (entry.value !== undefined && onDispose) {
      onDispose(entry.value, key);
    }
  }

  function isExpired(entry: Entry<T>, now: number): boolean {
    return ttlMs !== undefined && ttlMs > 0 && entry.value !== undefined && now - entry.lastAccess > ttlMs;
  }

  /** Moves a key to the most-recently-used position. */
  function touch(key: string, entry: Entry<T>, now: number): void {
    entry.lastAccess = now;
    entries.delete(key);
    entries.set(key, entry);
  }

  /** Drops a live entry if its TTL has elapsed. Returns true when it removed one. */
  function dropIfExpired(key: string, entry: Entry<T>, now: number): boolean {
    if (isExpired(entry, now)) {
      entries.delete(key);
      dispose(key, entry);
      return true;
    }
    return false;
  }

  function enforceLru(): void {
    if (maxEntries === undefined || maxEntries <= 0) return;
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      const key = oldest.value;
      const entry = entries.get(key);
      entries.delete(key);
      if (entry) dispose(key, entry);
    }
  }

  return {
    async getOrCreate(key: string, factory: () => Promise<T> | T): Promise<T> {
      const now = Date.now();
      const existing = entries.get(key);
      if (existing && !dropIfExpired(key, existing, now)) {
        touch(key, existing, now);
        if (existing.pending) return existing.pending;
        if (existing.value !== undefined) return existing.value;
      }

      const entry: Entry<T> = { lastAccess: now };
      const pending = (async () => factory())();
      entry.pending = pending;
      entries.set(key, entry);

      try {
        const value = await pending;
        // Only commit if this entry is still the one registered (not evicted mid-flight).
        if (entries.get(key) === entry) {
          entry.value = value;
          entry.pending = undefined;
          entry.lastAccess = Date.now();
          enforceLru();
        }
        return value;
      } catch (err) {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
        throw err;
      }
    },

    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      const now = Date.now();
      if (dropIfExpired(key, entry, now)) return undefined;
      if (entry.value === undefined) return undefined;
      touch(key, entry, now);
      return entry.value;
    },

    has(key: string): boolean {
      const entry = entries.get(key);
      if (!entry) return false;
      if (dropIfExpired(key, entry, Date.now())) return false;
      return entry.value !== undefined;
    },

    evict(key: string): void {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      dispose(key, entry);
    },

    clear(): void {
      for (const [key, entry] of entries) {
        dispose(key, entry);
      }
      entries.clear();
    },

    get size(): number {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.value !== undefined) count++;
      }
      return count;
    },
  };
}
