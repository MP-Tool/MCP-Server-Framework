/**
 * In-memory Event Store for Streamable HTTP stream resumability.
 *
 * A bounded, per-stream-indexed replacement for the SDK's example `InMemoryEventStore`
 * (`examples/shared/inMemoryEventStore.js`), which the SDK itself documents as "not for
 * production use": it never evicts anything (unbounded memory growth for long-running
 * servers), replays by sorting *every* event ever stored across *all* streams on every
 * single reconnect, and recovers a stream ID by splitting the event ID string on `_` —
 * which silently breaks for the SDK's own standalone GET SSE stream (whose stream ID is
 * the literal string `_GET_stream`).
 *
 * This implementation instead keeps one bounded, insertion-ordered event log per stream
 * (via {@link BoundedMap}) plus a flat `eventId -> streamId` index, so a reconnect only
 * ever touches the relevant stream's events and no event ID is ever parsed.
 *
 * @module server/transport/streamable-http/in-memory-event-store
 */

import { randomUUID } from "node:crypto";
import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { BoundedMap } from "../../auth/oauth/state.js";

const EVICTION_INTERVAL_MS = 60_000;

const DEFAULT_MAX_EVENTS_PER_STREAM = 1000;
const DEFAULT_MAX_STREAMS = 1000;
const DEFAULT_TTL_MS = 300_000;

/** Options for {@link createInMemoryEventStore}. */
export interface InMemoryEventStoreOptions {
  /** Maximum events retained per stream; the oldest is evicted first past this cap. @default 1000 */
  readonly maxEventsPerStream?: number | undefined;
  /**
   * Maximum concurrently tracked streams; the least-recently-written-to stream is evicted
   * first (in its entirety) past this cap.
   * @default 1000
   */
  readonly maxStreams?: number | undefined;
  /**
   * Idle time-to-live in ms — a stream that hasn't received a new event for longer than
   * this is proactively evicted by a periodic sweep, so abandoned streams don't linger
   * until a capacity eviction happens to reach them. Pass `0` to disable the sweep.
   * @default 300000 (5 minutes)
   */
  readonly ttlMs?: number | undefined;
}

/** Result of {@link createInMemoryEventStore}. */
export interface InMemoryEventStoreResult extends EventStore {
  // Narrowed from optional-in-interface to always-implemented — this store supports O(1) lookup.
  getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined>;
  /**
   * Evicts every stream whose ID matches `predicate`, including all of its retained
   * events. Used e.g. to reclaim a closed session's streams promptly instead of waiting
   * for the TTL sweep or capacity eviction.
   *
   * @param predicate - Returns `true` for stream IDs that should be evicted
   * @returns Number of streams evicted
   */
  evictStreams(predicate: (streamId: StreamId) => boolean): number;
  /** Stops the idle-stream eviction sweep. Call during server shutdown. Idempotent. */
  dispose(): void;
}

interface StreamRecord {
  /** Insertion-ordered per-stream event log — insertion order is replay order. */
  readonly events: BoundedMap<EventId, JSONRPCMessage>;
  /** Updated on every `storeEvent`; drives the idle-TTL sweep. */
  lastEventAt: number;
}

/**
 * Creates an in-memory {@link EventStore} for Streamable HTTP stream resumability.
 *
 * Bounded by `maxStreams` x `maxEventsPerStream` (a hard ceiling — the internal
 * `eventId -> streamId` index never exceeds this product) plus idle-stream TTL sweeping.
 * Suitable for single-instance deployments; for horizontal scaling, implement
 * {@link EventStore} against a shared backend (Redis, PostgreSQL, etc.).
 *
 * @param options - Capacity and TTL bounds
 * @returns A new in-memory event store
 */
export function createInMemoryEventStore(options?: InMemoryEventStoreOptions): InMemoryEventStoreResult {
  const maxEventsPerStream = options?.maxEventsPerStream ?? DEFAULT_MAX_EVENTS_PER_STREAM;
  const maxStreams = options?.maxStreams ?? DEFAULT_MAX_STREAMS;
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;

  // Flat eventId -> streamId index, kept in sync with `streams` by every eviction path —
  // both the capacity-triggered ones (via onEvict below) and the TTL sweep (which must
  // scrub it manually; see the comment on the sweep for why).
  const eventIndex = new Map<EventId, StreamId>();

  /** Removes every event of an evicted stream from `eventIndex`. Shared by both eviction paths. */
  function scrubStream(_streamId: StreamId, record: StreamRecord): void {
    for (const [eventId] of record.events.entries()) {
      eventIndex.delete(eventId);
    }
  }

  const streams = new BoundedMap<StreamId, StreamRecord>(maxStreams, scrubStream);

  let evictionTimer: NodeJS.Timeout | undefined;
  if (ttlMs > 0) {
    evictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [streamId, record] of streams.entries()) {
        if (now - record.lastEventAt > ttlMs) {
          // BoundedMap.delete() does NOT invoke onEvict (only set()'s capacity path does) —
          // scrub the flat index manually here, reusing the same helper as that path.
          streams.delete(streamId);
          scrubStream(streamId, record);
        }
      }
    }, EVICTION_INTERVAL_MS);
    evictionTimer.unref();
  }

  return {
    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
      const eventId = randomUUID();
      const now = Date.now();

      const existing = streams.get(streamId);
      const record: StreamRecord = existing ?? {
        events: new BoundedMap<EventId, JSONRPCMessage>(maxEventsPerStream, (evictedEventId) =>
          eventIndex.delete(evictedEventId),
        ),
        lastEventAt: now,
      };
      record.lastEventAt = now;
      // Defensive copy — stored by value, so a later mutation of the caller's message
      // object can never alter what a future replay delivers.
      record.events.set(eventId, structuredClone(message));

      // Touch to MRU position — Map.set() on an existing key does not reposition it, so a
      // delete + re-set is required (same technique identity-store.ts's touch() uses) for
      // "least-recently-written" eviction to actually track writes, not just first-insert order.
      if (existing) streams.delete(streamId);
      streams.set(streamId, record);

      eventIndex.set(eventId, streamId);
      return eventId;
    },

    async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
      return eventIndex.get(eventId);
    },

    evictStreams(predicate: (streamId: StreamId) => boolean): number {
      let count = 0;
      // Materialize first — deleting while iterating a live Map iterator is legal but
      // subtle; the stream count is capped at maxStreams, so this stays cheap.
      const matches: Array<[StreamId, StreamRecord]> = [];
      for (const [streamId, record] of streams.entries()) {
        if (predicate(streamId)) matches.push([streamId, record]);
      }
      for (const [streamId, record] of matches) {
        // BoundedMap.delete() does NOT invoke onEvict — scrub the flat index manually,
        // same as the TTL sweep above.
        streams.delete(streamId);
        scrubStream(streamId, record);
        count++;
      }
      return count;
    },

    async replayEventsAfter(
      lastEventId: EventId,
      { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
    ): Promise<StreamId> {
      if (!lastEventId) return "";
      const streamId = eventIndex.get(lastEventId);
      if (!streamId) return "";
      const record = streams.get(streamId);
      if (!record) return "";

      let foundLastEvent = false;
      for (const [eventId, message] of record.events.entries()) {
        if (eventId === lastEventId) {
          foundLastEvent = true;
          continue;
        }
        if (foundLastEvent) {
          await send(eventId, message);
        }
      }
      return streamId;
    },

    dispose(): void {
      clearInterval(evictionTimer);
    },
  };
}
