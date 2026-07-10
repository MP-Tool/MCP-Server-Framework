/**
 * Session-scoped Event Store decorator.
 *
 * The SDK's {@link EventStore} contract carries no session context — replay authorization
 * is gated solely by knowledge of an event ID. With one shared store passed into every
 * per-session SDK transport, that has two consequences:
 *
 * 1. The SDK stores standalone-GET-stream events under the hardcoded constant
 *    `'_GET_stream'` — identical for every transport instance — so all sessions' GET-stream
 *    events interleave in a single stream record, and a client resuming its own GET stream
 *    replays other sessions' events.
 * 2. A client that learns an event ID from another session's stream can replay that
 *    stream's JSON-RPC messages onto its own connection.
 *
 * This decorator closes both gaps transparently: each instance holds a random scope key
 * and namespaces every stream ID on the way *into* the inner store (`scope:rawStreamId`).
 * Replay of a stream that doesn't carry this instance's scope fails closed. Because the
 * stateful handler creates exactly one wrapper per SDK transport, and one transport per
 * session, per-wrapper scope is per-session scope. Works with any `EventStore`
 * implementation (in-memory, Redis, ...), which never sees session semantics.
 *
 * **Raw-in/raw-out constraint:** the SDK keys its internal stream mapping by the raw
 * stream IDs it generated on the send path, and uses the IDs returned from
 * `getStreamIdForEventId` / `replayEventsAfter` against that same mapping (conflict check
 * and resumed-connection registration). Returning a namespaced ID would register the
 * resumed connection under a key the send path never uses — replayed events would arrive
 * but new ones never would. The namespace therefore exists only inside the inner store:
 * stripped from every ID before it is returned to the SDK.
 *
 * @module server/transport/streamable-http/session-scoped-event-store
 */

import { randomUUID } from "node:crypto";
import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** A session-scoped view of a shared {@link EventStore}. */
export interface SessionScopedEventStore extends EventStore {
  /**
   * Evicts every stream stored through this wrapper from the inner store — prompt
   * data-minimization when the owning session closes, instead of waiting for the inner
   * store's TTL sweep or capacity eviction. Best-effort: a no-op when the inner store
   * exposes no bulk eviction (duck-typed `evictStreams(predicate)`, as implemented by
   * `createInMemoryEventStore()`).
   */
  evictOwnStreams(): void;
}

/** Duck-type for inner stores that support predicate-based bulk eviction. */
function supportsEvictStreams(
  store: EventStore,
): store is EventStore & { evictStreams(predicate: (streamId: StreamId) => boolean): number } {
  return "evictStreams" in store && typeof store.evictStreams === "function";
}

/**
 * Wraps an {@link EventStore} so that all streams stored through this instance are
 * namespaced under a private, unguessable scope key, and replay of any stream outside
 * that scope fails closed (`undefined` / `""` — the SDK responds 400 / starts fresh).
 *
 * Create one wrapper per SDK transport (= per session). The scope key is a
 * `crypto.randomUUID()` minted at creation; it never leaves the process and is never
 * exposed to clients.
 *
 * @param inner - The shared underlying store (session-agnostic)
 * @returns A session-scoped view of `inner`
 */
export function createSessionScopedEventStore(inner: EventStore): SessionScopedEventStore {
  // UUIDs contain no ":", so `${scope}:` unambiguously delimits the namespace.
  const prefix = `${randomUUID()}:`;

  function namespaced(rawStreamId: StreamId): StreamId {
    return `${prefix}${rawStreamId}`;
  }

  /** Strips this instance's prefix; `undefined` when the ID belongs to another scope. */
  function stripOwnPrefix(namespacedStreamId: StreamId): StreamId | undefined {
    return namespacedStreamId.startsWith(prefix) ? namespacedStreamId.slice(prefix.length) : undefined;
  }

  const store: SessionScopedEventStore = {
    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
      return inner.storeEvent(namespaced(streamId), message);
    },

    evictOwnStreams(): void {
      if (supportsEvictStreams(inner)) {
        inner.evictStreams((streamId) => streamId.startsWith(prefix));
      }
    },

    async replayEventsAfter(
      lastEventId: EventId,
      { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
    ): Promise<StreamId> {
      // Preferred path: pre-check ownership before any event is emitted.
      if (inner.getStreamIdForEventId) {
        const owner = await inner.getStreamIdForEventId(lastEventId);
        if (!owner || stripOwnPrefix(owner) === undefined) return "";
        const replayed = await inner.replayEventsAfter(lastEventId, { send });
        return stripOwnPrefix(replayed) ?? "";
      }

      // Fallback for inner stores without getStreamIdForEventId: ownership is only known
      // from replayEventsAfter's return value, so buffer the events and flush them to the
      // real send only once the stream is confirmed to be ours — never before.
      const buffered: Array<[EventId, JSONRPCMessage]> = [];
      const replayed = await inner.replayEventsAfter(lastEventId, {
        send: async (eventId, message) => {
          buffered.push([eventId, message]);
        },
      });
      const rawStreamId = stripOwnPrefix(replayed);
      if (rawStreamId === undefined) return "";
      for (const [eventId, message] of buffered) {
        await send(eventId, message);
      }
      return rawStreamId;
    },
  };

  // Only mirror the optional method when the inner store has it — an unconditional
  // implementation returning undefined would 400 every legitimate resume for inner
  // stores that rely on the SDK's replayEventsAfter fallback.
  if (inner.getStreamIdForEventId) {
    const innerGet = inner.getStreamIdForEventId.bind(inner);
    store.getStreamIdForEventId = async (eventId: EventId): Promise<StreamId | undefined> => {
      const owner = await innerGet(eventId);
      return owner === undefined ? undefined : stripOwnPrefix(owner);
    };
  }

  return store;
}
