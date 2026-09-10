// Independent oracle for undo and conflicts (TI-021, astra-21).
//
// The oracle is not the production classifier: UNDO_SUBJECT_FIELDS is an
// explicit list of the fields undo must restore, the reference model records
// the intent of each generated command, time moves with every command and
// revisions must strictly grow with each subject change. A guard compares the
// list with the production `taskFields`, so a field dropped on either side
// surfaces.
//
// Control mutation (verified 2026-09-10): remove 'note' from `taskFields` in
// src/shared/commands.ts. The guard fails (the lists differ) and, with the
// guard skipped, the model property fails because undo no longer restores
// `note`. A `note` that the classifier and the comparison both forget can not
// stay green here.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyCommand, taskFields } from '../../src/shared/commands.js';
import { executeOperation } from '../../src/server/operations.js';
import {
  openDatabase,
  migrate,
  readState,
  readEvents,
} from '../../src/server/db.js';
import { DomainError } from '../../src/shared/errors.js';
import type {
  Command,
  DomainEvent,
  OperationError,
  Task,
  WorkspaceState,
} from '../../src/shared/model.js';
import { agent, owner } from '../api/helpers.js';
export const UNDO_SUBJECT_FIELDS = [
  'area',
  'projectId',
  'title',
  'status',
  'note',
  'due',
  'waitingFor',
  'followUp',
  'orderKey',
  'focus',
  'archived',
  'checklist',
  'originUrl',
] as const satisfies readonly (keyof Task)[];
type SubjectField = (typeof UNDO_SUBJECT_FIELDS)[number];
type Subject = Record<SubjectField, unknown>;
const subject = (task: Task): Subject =>
  Object.fromEntries(
    UNDO_SUBJECT_FIELDS.map((field) => [field, structuredClone(task[field])]),
  ) as Subject;
// Time that moves: one second per command.
function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 8, 12, 0, tick++)).toISOString();
}
// A workspace driven by applyCommand with the event history an executor would
// keep; the property checks live outside of it.
function workspace() {
  let state: WorkspaceState = { tasks: [], projects: [], comments: [] };
  const history: DomainEvent[] = [];
  const now = clock();
  let ids = 0;
  const apply = (
    command: Command,
    operationId: string,
    actor = owner,
    at = now(),
  ) => {
    const result = applyCommand(state, command, {
      now: at,
      actor,
      ids: () => `id-${ids++}`,
      history,
      operationId,
    });
    state = result.state;
    const firstSeq = history.length + 1;
    for (const effect of result.effects)
      history.push({
        ...effect,
        generation: 'g',
        seq: history.length + 1,
        at,
        actorId: actor.id,
        actorLabel: actor.label,
        operationId,
        firstSeq,
        lastSeq: firstSeq + result.effects.length - 1,
      });
    return result;
  };
  return {
    apply,
    now,
    get state() {
      return state;
    },
    get history() {
      return history;
    },
  };
}
const dateOf = (value: number) =>
  `2026-09-${String((value % 28) + 1).padStart(2, '0')}`;
// Every generated action names the field it changes and the value the model
// expects afterwards.
const intents = [
  (v: number) => ({ field: 'note' as const, value: `note ${v}` }),
  (v: number) => ({
    field: 'status' as const,
    value: v % 2 ? 'done' : 'waiting',
  }),
  (v: number) => ({ field: 'due' as const, value: dateOf(v) }),
  (v: number) => ({ field: 'title' as const, value: `Title ${v}` }),
  (v: number) => ({ field: 'waitingFor' as const, value: `wait ${v}` }),
  (v: number) => ({ field: 'followUp' as const, value: dateOf(v + 7) }),
];
const command = (
  task: Task,
  intent: { field: SubjectField; value: unknown },
): Command => {
  const base = { id: task.id, baseRevision: task.revision };
  switch (intent.field) {
    case 'status':
      return {
        command: 'task.move',
        payload: { ...base, status: intent.value as 'done' | 'waiting' },
      };
    case 'followUp':
      return {
        command: 'task.save',
        payload: { ...base, fields: { followUp: intent.value as string } },
      };
    default:
      return {
        command: 'task.update',
        payload: { ...base, [intent.field]: intent.value },
      };
  }
};
const action = fc.record({
  task: fc.integer({ min: 0, max: 2 }),
  intent: fc.integer({ min: 0, max: intents.length - 1 }),
  value: fc.integer({ min: 1, max: 1000 }),
});
describe('undo restores the subject fields of the oracle', () => {
  it('guard: the production subject list is exactly the oracle list', () => {
    expect([...taskFields].sort()).toEqual([...UNDO_SUBJECT_FIELDS].sort());
  });
  it('after a generated batch every task matches the model, revisions grow only with changes, and undo returns the snapshot', () => {
    fc.assert(
      fc.property(
        fc.array(action, { minLength: 1, maxLength: 30 }),
        (actions) => {
          const w = workspace();
          for (let i = 0; i < 3; i++)
            w.apply(
              {
                command: 'task.create',
                payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
              },
              `create-${i}`,
            );
          const snapshot = w.state.tasks.map(subject);
          const stamps = w.state.tasks.map((t) => ({
            revision: t.revision,
            updatedAt: t.updatedAt,
          }));
          // The model: the value each touched field must have after the batch.
          const model: Partial<Subject>[] = [{}, {}, {}];
          for (const { task: which, intent, value } of actions) {
            const t = w.state.tasks[which]!;
            const wanted = intents[intent]!(value);
            const changes = w.apply(command(t, wanted), 'batch').effects;
            const after = w.state.tasks[which]!;
            const previous = stamps[which]!;
            if (changes.length) {
              expect(after.revision).toBeGreaterThan(previous.revision);
              expect(after.updatedAt > previous.updatedAt).toBe(true);
              stamps[which] = {
                revision: after.revision,
                updatedAt: after.updatedAt,
              };
            } else {
              expect(after.revision).toBe(previous.revision);
              expect(after.updatedAt).toBe(previous.updatedAt);
            }
            model[which]![wanted.field] = wanted.value;
          }
          w.state.tasks.forEach((task, i) => {
            for (const [field, value] of Object.entries(model[i]!))
              expect(task[field as SubjectField]).toEqual(value);
          });
          const touched = model.map((m) => Object.keys(m).length > 0);
          w.apply(
            { command: 'undo', payload: { operationId: 'batch' } },
            'undo',
          );
          expect(w.state.tasks.map(subject)).toEqual(snapshot);
          w.state.tasks.forEach((task, i) => {
            const changed = !subjectEqual(snapshot[i]!, {
              ...snapshot[i]!,
              ...model[i],
            });
            expect(task.revision).toBeGreaterThanOrEqual(stamps[i]!.revision);
            if (touched[i] && changed)
              expect(task.revision).toBeGreaterThan(stamps[i]!.revision);
          });
        },
      ),
      { numRuns: 75 },
    );
  });
  it('a stale baseRevision conflicts exactly when the fields overlap', () => {
    const fields = ['title', 'note', 'waitingFor'] as const;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 0, max: 2 }),
        (first, second) => {
          const w = workspace();
          w.apply(
            {
              command: 'task.create',
              payload: { id: 't', area: 'agency', title: 'T' },
            },
            'create',
          );
          w.apply(
            {
              command: 'task.update',
              payload: { id: 't', baseRevision: 1, [fields[first]!]: 'first' },
            },
            'first',
          );
          const stale = {
            command: 'task.update' as const,
            payload: { id: 't', baseRevision: 1, [fields[second]!]: 'second' },
          };
          if (first === second) {
            let error: DomainError | undefined;
            try {
              w.apply(stale, 'second');
            } catch (e) {
              error = e as DomainError;
            }
            expect(error?.code).toBe('conflict');
            const details = error!.details as OperationError;
            expect(details.conflicts).toEqual([
              { entityKind: 'task', entityId: 't', fields: [fields[first]] },
            ]);
            expect((details.current as Task).revision).toBe(2);
            expect(w.state.tasks[0]![fields[first]!]).toBe('first');
          } else {
            w.apply(stale, 'second');
            expect(w.state.tasks[0]![fields[first]!]).toBe('first');
            expect(w.state.tasks[0]![fields[second]!]).toBe('second');
            expect(w.state.tasks[0]!.revision).toBe(3);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
  it('undo of a task created by task.sync archives it and leaves the origin version alone', () => {
    const w = workspace();
    w.apply(
      {
        command: 'task.sync',
        payload: {
          origin: { system: 'tg', ref: '1', version: '3' },
          fields: { area: 'agency', title: 'From source', note: 'v3' },
        },
      },
      'sync',
      agent,
    );
    const created = w.state.tasks[0]!;
    expect(created.originVersion).toBe('3');
    w.apply({ command: 'undo', payload: { operationId: 'sync' } }, 'undo');
    const after = w.state.tasks[0]!;
    expect(after.archived).toBe(true);
    expect(after.originVersion).toBe('3');
    expect(after.originSystem).toBe('tg');
    expect(after.title).toBe('From source');
    expect(after.revision).toBe(2);
  });
});
describe('the executor keeps batches atomic and outcomes stable', () => {
  it('a rejected batch changes neither state nor history, is stored once and repeats identically', () => {
    fc.assert(
      fc.property(
        fc.array(action, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 2 }),
        (actions, victim) => {
          const db = openDatabase(':memory:');
          try {
            migrate(db);
            const now = clock();
            const gen = db.sqlite
              .prepare("SELECT value FROM settings WHERE key='generation'")
              .get() as { value: string };
            const run = (input: Parameters<typeof executeOperation>[1]) =>
              executeOperation(db, input, owner, { now: now() });
            for (let i = 0; i < 3; i++)
              run({
                operationId: `create-${i}`,
                generation: gen.value,
                command: 'task.create',
                payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
              });
            const before = readState(db);
            const events = readEvents(db).length;
            const commands: Command[] = actions.map(
              ({ task: which, intent, value }) => {
                const t = before.tasks[which]!;
                return command(t, intents[intent]!(value));
              },
            );
            // Every command carries the pre-batch baseRevision, so the first
            // repeated task would conflict; the poisoned move fails first
            // only if it comes first, hence it is placed at the front.
            const poisoned: Command = {
              command: 'task.move',
              payload: {
                id: `t${victim}`,
                baseRevision: before.tasks[victim]!.revision,
                status: 'doing',
                before: 'no-such-task',
              },
            };
            const batch = {
              operationId: 'batch',
              generation: gen.value,
              commands: [poisoned, ...commands],
            };
            const first = run(batch);
            expect(first.status).toBe(400);
            expect(first.body).toMatchObject({
              code: 'invalid',
              commandIndex: 0,
            });
            expect(readState(db)).toEqual(before);
            expect(readEvents(db)).toHaveLength(events);
            const again = run(batch);
            expect(again.body).toEqual(first.body);
            expect(again.freshOperation).toBe(false);
            expect(
              (
                db.sqlite
                  .prepare('SELECT COUNT(*) AS n FROM operations')
                  .get() as {
                  n: number;
                }
              ).n,
            ).toBe(4);
          } finally {
            db.close();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
function subjectEqual(a: Subject, b: Subject) {
  return JSON.stringify(a) === JSON.stringify(b);
}
