import type { Actor, DomainEvent } from '../shared/model.js';
import { LIMITS } from '../shared/limits.js';
import type { Credential } from './auth.js';
// Idle streams re-check access on every heartbeat, so revocation reaches an
// open stream no later than this interval (or the next delivery, if sooner).
export const SSE_HEARTBEAT_MS = 25_000;
// A cursor further behind than this gets `event: reset` (take a snapshot)
// instead of a tail; a shorter tail streams in portions of one page.
export const SSE_BACKLOG_LIMIT = 5_000;
const SSE_BACKLOG_CHUNK = LIMITS.pageSize;
type CloseReason = 'revoked' | 'shutdown';
export type Subscriber = {
  actor: Actor;
  credential: Credential;
  check: () => boolean | Promise<boolean>;
  onEvents: (events: DomainEvent[]) => void;
  onOperations: () => void;
  close: (reason: CloseReason) => void;
};
export type EventHub = ReturnType<typeof createEventHub>;
export function createEventHub() {
  const subscribers = new Set<Subscriber>();
  const queues = new WeakMap<Subscriber, Promise<void>>();
  const drop = (s: Subscriber, reason: CloseReason) => {
    if (!subscribers.delete(s)) return;
    try {
      s.close(reason);
    } catch {
      /* the stream is already gone */
    }
  };
  // Every delivery passes the same gate: a successful check immediately before
  // sending. Deliveries to one subscriber stay ordered even when checks await.
  const deliver = (s: Subscriber, send: () => void) => {
    const run = async () => {
      if (!subscribers.has(s)) return;
      let allowed = false;
      try {
        allowed = await s.check();
      } catch {
        allowed = false;
      }
      if (!allowed) return drop(s, 'revoked');
      if (!subscribers.has(s)) return;
      try {
        send();
      } catch {
        drop(s, 'shutdown');
      }
    };
    queues.set(s, (queues.get(s) ?? Promise.resolve()).then(run));
  };
  return {
    subscribe(s: Subscriber) {
      subscribers.add(s);
      return () => {
        subscribers.delete(s);
      };
    },
    publish(events: DomainEvent[]) {
      if (!events.length) return;
      for (const s of subscribers) deliver(s, () => s.onEvents(events));
    },
    // Catch-up for one stream: same gate as a broadcast.
    publishTo(s: Subscriber, events: DomainEvent[]) {
      if (events.length) deliver(s, () => s.onEvents(events));
    },
    notifyOperations() {
      for (const s of subscribers) deliver(s, () => s.onOperations());
    },
    closeFor(predicate: (s: Subscriber) => boolean) {
      for (const s of subscribers) if (predicate(s)) drop(s, 'revoked');
    },
    closeAll() {
      for (const s of subscribers) drop(s, 'shutdown');
    },
    get size() {
      return subscribers.size;
    },
  };
}
// Catch-up for one stream in portions (plan 01, step 10): every portion goes
// through the hub's gate, and `ready` runs between portions — it yields to
// the event loop so live requests are served while a long tail streams, and
// answers false once the stream is gone.
export async function replayBacklog(
  hub: EventHub,
  s: Subscriber,
  since: number,
  read: (since: number, limit: number) => DomainEvent[],
  ready: () => Promise<boolean>,
) {
  let cursor = since;
  for (;;) {
    const chunk = read(cursor, SSE_BACKLOG_CHUNK + 1);
    hub.publishTo(s, chunk.slice(0, SSE_BACKLOG_CHUNK));
    if (chunk.length <= SSE_BACKLOG_CHUNK) return;
    cursor = chunk[SSE_BACKLOG_CHUNK - 1]!.seq;
    if (!(await ready())) return;
  }
}
