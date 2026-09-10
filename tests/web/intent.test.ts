import { describe, it, expect } from 'vitest';
import {
  newIntent,
  nextIntent,
  type Intent,
  type IntentPhase,
} from '../../src/web/app/intent';
// TI-023 (план 07, доп. шаг 25): один жизненный цикл намерения для всех форм.
// Раньше `QuickCreate` брал новый `operationId` при любом неповторяемом отказе,
// `InlineCreate` обнулял намерение, а `TaskDiscussion` сохранял его.
let counter = 0;
const ids = () => `op-${++counter}`;
const run = (
  start: Intent,
  events: Parameters<typeof nextIntent>[1][],
): Intent =>
  events.reduce((intent, event) => nextIntent(intent, event, ids), start);
const phases = (intent: Intent): [IntentPhase, string] => [
  intent.phase,
  intent.operationId,
];
describe('intent lifecycle', () => {
  it('goes editing → persisted → sending → success', () => {
    const start = newIntent('op-0');
    const sent = run(start, [
      { type: 'edit', signature: 'a' },
      { type: 'persist' },
      { type: 'send', signature: 'a' },
    ]);
    expect(phases(sent)).toEqual(['sending', 'op-0']);
    const done = nextIntent(sent, { type: 'success' }, ids);
    expect(done.phase).toBe('success');
    expect(done.operationId).not.toBe('op-0');
  });
  it('a definitive rejection keeps the operation until the text changes', () => {
    const rejected = run(newIntent('op-0'), [
      { type: 'send', signature: 'a' },
      { type: 'reject', retryable: false },
    ]);
    expect(phases(rejected)).toEqual(['rejected', 'op-0']);
    // Тот же текст — та же операция: сервер ответит сохранённым отказом.
    expect(
      nextIntent(rejected, { type: 'edit', signature: 'a' }, ids).operationId,
    ).toBe('op-0');
    const edited = nextIntent(rejected, { type: 'edit', signature: 'b' }, ids);
    expect(edited.phase).toBe('editing');
    expect(edited.operationId).not.toBe('op-0');
  });
  it('an unknown outcome keeps the operation even after edits', () => {
    const unknown = run(newIntent('op-0'), [
      { type: 'send', signature: 'a' },
      { type: 'reject', retryable: true },
    ]);
    expect(phases(unknown)).toEqual(['unknown', 'op-0']);
    expect(
      nextIntent(unknown, { type: 'edit', signature: 'b' }, ids).operationId,
    ).toBe('op-0');
    expect(
      nextIntent(unknown, { type: 'edit', signature: 'b' }, ids).phase,
    ).toBe('unknown');
  });
  it('an edit during sending does not start another operation', () => {
    const sending = nextIntent(
      newIntent('op-0'),
      { type: 'send', signature: 'a' },
      ids,
    );
    expect(
      nextIntent(sending, { type: 'edit', signature: 'b' }, ids),
    ).toStrictEqual(sending);
  });
  it('persist only marks a draft that is being edited', () => {
    const editing = newIntent('op-0');
    expect(nextIntent(editing, { type: 'persist' }, ids).phase).toBe(
      'persisted',
    );
    const sending = nextIntent(editing, { type: 'send', signature: 'a' }, ids);
    expect(nextIntent(sending, { type: 'persist' }, ids).phase).toBe('sending');
  });
});
