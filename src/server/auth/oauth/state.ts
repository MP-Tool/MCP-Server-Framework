/**
 * Bounded Map — generic Map with FIFO eviction on capacity overflow plus opt-in TTL sweeps.
 *
 * Used by the OAuth provider core and the streamable-HTTP event store to hold in-memory
 * state with bounded-memory guarantees.
 *
 * ## Why this isn't the framework's only bounded collection
 *
 * `BoundedMap` is the simplest point on a deliberate spectrum — the other bounded
 * collections are NOT accidental duplicates, they encode different eviction policies:
 *
 * - **`BoundedMap`** (here) — FIFO cap + explicit `evictExpired()` sweep. Insertion order
 *   only; access does not affect eviction. Cheapest; fits token/code/client registries.
 * - **`createIdentityStore`** (`server/auth/identity-store`) — TTL + true LRU (access bumps
 *   recency) + `onDispose` on every removal path. For entries that own resources.
 * - **`InMemorySessionStore`** (`server/session/in-memory-store`) — *rejects* new entries at
 *   capacity rather than evicting an existing session (a live session must not be dropped).
 * - **OIDC discovery cache** (`server/auth/oauth/discovery`) — TTL checked lazily on read,
 *   no background sweep, tiny fixed key space.
 *
 * When adding bounded state, pick the closest of these rather than hand-rolling a fifth.
 *
 * @module server/auth/oauth/state
 */

/**
 * A `Map<K, V>` that enforces a maximum size via FIFO eviction.
 *
 * When {@link set} is called and the map is at capacity, the oldest entry (by insertion
 * order) is removed before inserting the new one. An optional `onEvict` callback allows
 * callers to react to evictions (e.g. for logging).
 *
 * TTL-based expiry is performed explicitly via {@link evictExpired} — call it from a
 * periodic timer to proactively clean up stale entries between capacity-triggered evictions.
 */
export class BoundedMap<K, V> {
  private readonly inner = new Map<K, V>();

  constructor(
    private readonly maxSize: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  set(key: K, value: V): void {
    if (!this.inner.has(key) && this.inner.size >= this.maxSize) {
      const oldestEntry = this.inner.entries().next().value;
      if (oldestEntry !== undefined) {
        const [oldestKey, oldestValue] = oldestEntry;
        this.inner.delete(oldestKey);
        this.onEvict?.(oldestKey, oldestValue);
      }
    }
    this.inner.set(key, value);
  }

  get(key: K): V | undefined {
    return this.inner.get(key);
  }

  has(key: K): boolean {
    return this.inner.has(key);
  }

  delete(key: K): boolean {
    return this.inner.delete(key);
  }

  get size(): number {
    return this.inner.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.inner.entries();
  }

  /**
   * Evicts all entries whose timestamp (returned by `getTimestamp`) is older than `ttlMs`.
   *
   * @param ttlMs - Maximum age in milliseconds
   * @param getTimestamp - Extracts the creation timestamp from a value
   * @param now - Current time in ms (defaults to `Date.now()`)
   * @returns Number of entries evicted
   */
  evictExpired(ttlMs: number, getTimestamp: (value: V) => number, now = Date.now()): number {
    let count = 0;
    for (const [key, value] of this.inner) {
      if (now - getTimestamp(value) > ttlMs) {
        this.inner.delete(key);
        count++;
      }
    }
    return count;
  }
}
