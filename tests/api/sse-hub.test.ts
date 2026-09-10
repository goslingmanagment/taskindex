import { it, expect } from 'vitest';
import { createEventHub } from '../../src/server/sse.js';
import type { Subscriber } from '../../src/server/sse.js';
import type { DomainEvent } from '../../src/shared/model.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = (seq: number) => ({ seq }) as unknown as DomainEvent;
function subscriber(agentId: string, check: Subscriber['check'] = () => true) {
  const got = {
    events: [] as DomainEvent[],
    operations: 0,
    closed: [] as string[],
  };
  const s: Subscriber = {
    actor: {
      id: `agent:${agentId}`,
      agentId,
      label: agentId,
      kind: 'agent',
      scope: 'read',
    },
    credential: { kind: 'agent-key', keyId: `${agentId}-key`, agentId },
    check,
    onEvents: (events) => got.events.push(...events),
    onOperations: () => got.operations++,
    close: (reason) => got.closed.push(reason),
  };
  return { s, got };
}
it('delivers events and operation hints to every subscriber, honours unsubscribe and closeAll', async () => {
  const hub = createEventHub();
  const a = subscriber('a');
  const b = subscriber('b');
  hub.subscribe(a.s);
  const unsubscribeB = hub.subscribe(b.s);
  hub.publish([event(1)]);
  hub.notifyOperations();
  await sleep(0);
  expect(a.got).toMatchObject({ events: [event(1)], operations: 1 });
  expect(b.got).toMatchObject({ events: [event(1)], operations: 1 });
  unsubscribeB();
  hub.publish([event(2)]);
  await sleep(0);
  expect(a.got.events).toEqual([event(1), event(2)]);
  expect(b.got.events).toEqual([event(1)]);
  expect(hub.size).toBe(1);
  hub.closeAll();
  expect(a.got.closed).toEqual(['shutdown']);
  expect(b.got.closed).toEqual([]);
  expect(hub.size).toBe(0);
});
it('re-checks access before every delivery, closes failing subscribers as revoked and keeps deliveries ordered across async checks', async () => {
  const hub = createEventHub();
  const denied = subscriber('denied', () => false);
  const failing = subscriber('failing', () => {
    throw new Error('auth backend down');
  });
  let allowed = true;
  const later = subscriber('later', () => allowed);
  const slow = subscriber('slow', async () => {
    await sleep(Math.random() * 5);
    return true;
  });
  for (const x of [denied, failing, later, slow]) hub.subscribe(x.s);
  hub.publish([event(1)]);
  await sleep(20);
  expect(denied.got).toEqual({
    events: [],
    operations: 0,
    closed: ['revoked'],
  });
  expect(failing.got).toEqual({
    events: [],
    operations: 0,
    closed: ['revoked'],
  });
  expect(later.got.events).toEqual([event(1)]);
  expect(hub.size).toBe(2);
  allowed = false;
  hub.notifyOperations();
  await sleep(0);
  expect(later.got).toMatchObject({ operations: 0, closed: ['revoked'] });
  for (let seq = 2; seq <= 6; seq++) hub.publish([event(seq)]);
  await sleep(50);
  expect(slow.got.events.map((e) => (e as { seq: number }).seq)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
  expect(slow.got.closed).toEqual([]);
});
it('closeFor closes only matching subscribers and publishTo gates a single catch-up delivery', async () => {
  const hub = createEventHub();
  const a1 = subscriber('a');
  const a2 = subscriber('a');
  const b = subscriber('b');
  for (const x of [a1, a2, b]) hub.subscribe(x.s);
  hub.closeFor(
    (s) => s.credential.kind === 'agent-key' && s.credential.agentId === 'a',
  );
  expect(a1.got.closed).toEqual(['revoked']);
  expect(a2.got.closed).toEqual(['revoked']);
  expect(b.got.closed).toEqual([]);
  expect(hub.size).toBe(1);
  hub.publishTo(b.s, [event(9)]);
  hub.publishTo(a1.s, [event(9)]);
  await sleep(0);
  expect(b.got.events).toEqual([event(9)]);
  expect(a1.got.events).toEqual([]);
});
