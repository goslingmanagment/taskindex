import { describe, it, expect } from 'vitest';
import { createEventHub } from '../../src/server/sse.js';
import type { Subscriber } from '../../src/server/sse.js';
import type { DomainEvent } from '../../src/shared/model.js';
import { generation } from '../../src/server/db.js';
import { fixture, success } from './helpers.js';
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
// Plan 01, step 10 and test 9: a long catch-up streams in portions through
// the hub's gate with the event loop running between them; a cursor further
// behind than sseBacklogLimit gets `event: reset` and a closed stream.
describe('SSE backlog (plan 01, phase 3)', () => {
  const seed = async (f: ReturnType<typeof fixture>, count: number) => {
    for (let batch = 0; batch < count / 100; batch++)
      success(
        await f.batch(
          Array.from({ length: 100 }, (_, i) => ({
            command: 'task.create' as const,
            payload: {
              id: `t-${batch}-${i}`,
              area: 'agency' as const,
              title: `T${batch}-${i}`,
            },
          })),
        ),
      );
  };
  it('replays 1 200 events in seq order as portions of 500/500/200 through publishTo', async () => {
    const hub = createEventHub();
    const portions: number[] = [];
    const publishTo = hub.publishTo.bind(hub);
    hub.publishTo = (s, events) => {
      portions.push(events.length);
      publishTo(s, events);
    };
    const f = fixture({ hub });
    await seed(f, 1200);
    const response = await f.app.request(
      `/api/events/stream?generation=${generation(f.db)}&since=0`,
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const seqs: number[] = [];
    while (seqs.length < 1200) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      const lines = text.split('\n\n');
      text = lines.pop() ?? '';
      for (const line of lines) {
        const id = /^id: [^:]+:(\d+)$/m.exec(line);
        if (id) seqs.push(Number(id[1]));
      }
    }
    await reader.cancel();
    expect(seqs).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
    expect(portions).toEqual([500, 500, 200]);
    f.close();
  });
  it('answers a cursor further behind than sseBacklogLimit with event: reset and closes', async () => {
    const f = fixture({ sseBacklogLimit: 100 });
    await seed(f, 200);
    const gen = generation(f.db);
    const reset = await f.app.request(
      `/api/events/stream?generation=${gen}&since=0`,
    );
    const body = await reset.text();
    expect(body).toContain('event: reset');
    expect(body).toContain(`"generation":"${gen}"`);
    expect(body).not.toContain('id: ');
    // Within the limit the tail streams as before.
    const near = await f.app.request(
      `/api/events/stream?generation=${gen}&since=150`,
    );
    const reader = near.body!.getReader();
    await reader.read();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain(`id: ${gen}:151\n`);
    await reader.cancel();
    f.close();
  });
});
