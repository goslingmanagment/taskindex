import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/shared/canonical-json.js';
import type { CommandOf } from '../../src/shared/model.js';
import { fixture, success } from '../api/helpers.js';
import * as schema from '../../src/server/schema.js';
// Golden envelope from plan 03 §1.5: the canonical string and its sha256 are
// the contract of `commandHash`; a change here changes stored hashes.
const GOLDEN_PAYLOAD: CommandOf<'task.create'>['payload'] = {
  title: 'Тест',
  area: 'agency',
  note: '',
  checklist: [{ id: 'i1', text: 'шаг', done: false }],
};
const GOLDEN_ENVELOPE = {
  operationId: 'op-golden',
  generation: 'gen-golden',
  command: 'task.create',
  payload: GOLDEN_PAYLOAD,
};
const GOLDEN_STRING =
  '{"command":"task.create","generation":"gen-golden","operationId":"op-golden","payload":{"area":"agency","checklist":[{"done":false,"id":"i1","text":"шаг"}],"note":"","title":"Тест"}}';
const GOLDEN_SHA256 =
  'fc548ecccf52804821ba08d9737c89558fd9d3eeb30c82450773316d0f2a2f19';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
describe('canonicalJson is the one canonical form (TI-061)', () => {
  it('matches the golden string and hash', () => {
    expect(canonicalJson(GOLDEN_ENVELOPE)).toBe(GOLDEN_STRING);
    expect(sha256(canonicalJson(GOLDEN_ENVELOPE))).toBe(GOLDEN_SHA256);
  });
  it('orders keys by code units at every depth, keeps arrays and drops undefined', () => {
    expect(canonicalJson({ ä: 4, a: 2, B: 1, _x: 3 })).toBe(
      '{"B":1,"_x":3,"a":2,"ä":4}',
    );
    expect(
      canonicalJson({ z: { b: [{ y: 1, x: 2 }, 3], a: null }, a: undefined }),
    ).toBe('{"z":{"a":null,"b":[{"x":2,"y":1},3]}}');
    expect(canonicalJson([{ b: 1, a: 2 }, 'x', 1, true, null])).toBe(
      '[{"a":2,"b":1},"x",1,true,null]',
    );
  });
  it('is what the server stores as commandHash', async () => {
    const f = fixture();
    const envelope = {
      ...GOLDEN_ENVELOPE,
      generation: (await (await f.app.request('/api/me')).json()).generation,
      dryRun: false,
    };
    success(
      await f.post(
        { command: 'task.create', payload: GOLDEN_PAYLOAD },
        { id: 'op-golden' },
      ),
    );
    const row = f.db.orm.select().from(schema.operations).get()!;
    expect(row.commandHash).toBe(sha256(canonicalJson(envelope)));
    f.close();
  });
});
