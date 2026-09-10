import type { Actor, DomainEvent } from '../shared/model.js';
import type { Credential } from './auth.js';
// Idle streams re-check access on every heartbeat, so revocation reaches an
// open stream no later than this interval (or the next delivery, if sooner).
export const SSE_HEARTBEAT_MS = 25_000;
export type CloseReason = 'revoked' | 'shutdown';
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
