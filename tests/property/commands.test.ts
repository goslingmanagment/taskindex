import { it, expect } from 'vitest';
import fc from 'fast-check';
import {
  applyCommand,
  applyEvent,
  assertInvariants,
} from '../../src/shared/commands.js';
import { DomainError } from '../../src/shared/errors.js';
import type {
  Actor,
  Command,
  DomainEvent,
  WorkspaceState,
} from '../../src/shared/model.js';
import { agent, nightShift, owner } from '../api/helpers.js';
import { defaultAppearance } from '../../src/shared/domain-schemas.js';
import { SEEDED_LABELS } from '../../src/shared/labels.js';
const actors: Actor[] = [owner, agent, { ...agent, scope: 'tasks' }];
it('random command sequences by owner and agents preserve invariants, the event projection and the owner-only policy', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          task: fc.integer({ min: 0, max: 2 }),
          action: fc.integer({ min: 0, max: 12 }),
          actor: fc.integer({ min: 0, max: 2 }),
          confirm: fc.boolean(),
          value: fc.integer({ min: 0, max: 99 }),
        }),
        { minLength: 1, maxLength: 60 },
      ),
      (actions) => {
        let state: WorkspaceState = {
          projects: [],
          labels: structuredClone(SEEDED_LABELS),
          tasks: [],
          steps: [],
          comments: [],
          proposals: [],
          appearance: [defaultAppearance()],
        };
        let projection: WorkspaceState = {
          projects: [],
          labels: structuredClone(SEEDED_LABELS),
          tasks: [],
          steps: [],
          comments: [],
          proposals: [],
          appearance: [defaultAppearance()],
        };
        const history: DomainEvent[] = [];
        let ids = 0;
        let operations = 0;
        // Returns the refusal code, or undefined when the command applied.
        const apply = (
          command: Command,
          actor: Actor = owner,
          confirmOwnerFields = false,
        ): string | undefined => {
          const before = structuredClone(state);
          const operationId = `op-${operations++}`;
          let app;
          try {
            app = applyCommand(state, command, {
              now: '2026-09-08T12:00:00.000Z',
              actor,
              ids: () => `id-${ids++}`,
              history,
              operationId,
              confirmOwnerFields,
            });
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            expect(state).toEqual(before);
            return error.code;
          }
          state = app.state;
          const start = history.length + 1;
          const last = start + app.effects.length - 1;
          for (const effect of app.effects) {
            const event: DomainEvent = {
              ...effect,
              seq: history.length + 1,
              generation: 'g',
              at: '2026-09-08T12:00:00.000Z',
              actorId: actor.id,
              actorLabel: actor.label,
              operationId,
              firstSeq: start,
              lastSeq: last,
            };
            history.push(event);
            projection = applyEvent(projection, event);
          }
          assertInvariants(state);
          expect(projection).toEqual(state);
          for (const task of state.tasks) {
            const old = before.tasks.find((t) => t.id === task.id);
            if (old) expect(task.revision).toBeGreaterThanOrEqual(old.revision);
          }
          return undefined;
        };
        for (let i = 0; i < 3; i++)
          apply({
            command: 'task.create',
            payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
          });
        for (const action of actions) {
          const actor = actors[action.actor]!;
          const t = state.tasks[action.task]!;
          const base = { id: t.id, baseRevision: t.revision };
          const protectedBefore = new Set(t.ownerFields);
          // TI-095: the owner's fields of every step, before the command.
          const protectedSteps = new Map(
            state.steps.map((s) => [s.id, new Set(s.ownerFields)]),
          );
          const liveOf = (taskId: string) =>
            state.steps.filter((s) => s.taskId === taskId && !s.removedAt);
          const seen = history.length;
          let code: string | undefined;
          if (action.action === 0)
            code = apply(
              {
                command: 'task.update',
                payload: { ...base, note: `N${action.value}` },
              },
              actor,
              action.confirm,
            );
          else if (action.action === 1)
            code = apply(
              {
                command: 'task.move',
                payload: {
                  ...base,
                  status: ['todo', 'doing', 'waiting', 'done'][
                    action.value % 4
                  ] as 'todo' | 'doing' | 'waiting' | 'done',
                },
              },
              actor,
              action.confirm,
            );
          else if (action.action === 2)
            code = apply(
              {
                command: t.archived ? 'task.restore' : 'task.archive',
                payload: base,
              },
              actor,
              action.confirm,
            );
          else if (action.action === 3) {
            code = apply(
              {
                command: 'task.update',
                payload: { ...base, focus: action.value % 2 === 0 },
              },
              actor,
              action.confirm,
            );
            if (actor.kind !== 'owner') expect(code).toBe('forbidden');
          } else if (action.action === 4)
            code = apply(
              {
                command: 'comment.add',
                payload: { taskId: t.id, text: `Comment ${action.value}` },
              },
              actor,
            );
          else if (action.action === 5)
            code = apply(
              {
                command: 'checklist.add',
                payload: {
                  taskId: t.id,
                  baseRevision: t.revision,
                  text: `Step ${action.value}`,
                },
              },
              actor,
              action.confirm,
            );
          else if (action.action === 8 || action.action === 9) {
            // TI-095: a tick or a removal of one of the task's live steps.
            const live = liveOf(t.id);
            const target = live[action.value % Math.max(live.length, 1)];
            if (!target) continue;
            code = apply(
              action.action === 8
                ? {
                    command: 'checklist.update',
                    payload: {
                      taskId: t.id,
                      itemId: target.id,
                      baseRevision: target.revision,
                      done: !target.done,
                    },
                  }
                : {
                    command: 'checklist.remove',
                    payload: {
                      taskId: t.id,
                      itemId: target.id,
                      baseRevision: target.revision,
                    },
                  },
              actor,
              action.confirm,
            );
          } else if (action.action === 10) {
            // Spec 2026-09-25: the night shift proposes a new task or one
            // change of this task, as it saw it.
            const kind = action.value % 4;
            const evidence = [
              {
                source: 'board' as const,
                ref: t.id,
                at: '2026-09-08',
                quote: 'q',
              },
            ];
            code = apply(
              {
                command: 'proposal.create',
                payload:
                  kind === 0
                    ? {
                        kind: 'new_task',
                        command: {
                          command: 'task.create',
                          payload: {
                            area: 'agency',
                            title: `P${action.value}`,
                          },
                        },
                        reason: 'r',
                        evidence,
                        fingerprint: `new:${action.value}`,
                        rank: 1,
                      }
                    : {
                        kind: 'task_change',
                        command: {
                          command: (
                            [
                              'task.update',
                              'task.move',
                              'task.archive',
                            ] as const
                          )[kind - 1]!,
                          payload: {
                            ...base,
                            ...(kind === 1 ? { note: `P${action.value}` } : {}),
                            ...(kind === 2 ? { status: 'done' } : {}),
                          },
                        },
                        reason: 'r',
                        evidence,
                        fingerprint: `change:${t.id}:${t.revision}:${kind}`,
                        rank: 2,
                      },
              },
              nightShift,
            );
          } else if (action.action === 11)
            code = apply(
              { command: 'proposal.deliver', payload: {} },
              nightShift,
            );
          else if (action.action === 12) {
            // An agent or the owner answers a shown proposal by its number.
            const shown = state.proposals.filter((p) => p.status === 'shown');
            const target = shown[action.value % Math.max(shown.length, 1)];
            if (!target) continue;
            code = apply(
              action.value % 2 === 0
                ? {
                    command: 'proposal.accept',
                    payload: { ref: String(target.number) },
                  }
                : {
                    command: 'proposal.reject',
                    payload: { ref: String(target.number), reason: 'нет' },
                  },
              actor,
            );
          } else if (action.action === 7) {
            // Plan 13: a desk position by the owner; agents are refused.
            const other = state.tasks[(action.task + 1) % 3]!;
            const position =
              action.value % 3 === 0
                ? { first: true as const }
                : action.value % 3 === 1
                  ? { after: other.id }
                  : { before: other.id };
            code = apply(
              {
                command: 'task.update',
                payload: { ...base, focusPosition: position },
              },
              actor,
              action.confirm,
            );
            if (actor.kind !== 'owner') expect(code).toBe('forbidden');
            else if (code === undefined) {
              const updated = state.tasks.find((x) => x.id === t.id)!;
              expect(updated.focus).toBe(true);
              expect(updated.focusKey).not.toBeNull();
            }
          } else {
            const lastOperation = history.at(-1)?.operationId;
            if (!lastOperation) continue;
            const ownerEvents = history.some(
              (e) => e.operationId === lastOperation && e.actorId === 'owner',
            );
            code = apply(
              { command: 'undo', payload: { operationId: lastOperation } },
              actor,
            );
            if (actor.kind !== 'owner' && ownerEvents)
              expect(code).toBe('forbidden');
          }
          // A direct agent command without confirmation never changes a field
          // the owner decided on (undo of another agent's operation may restore one).
          // An accepted proposal is the owner's own instruction (spec
          // 2026-09-25): its owner fields count as confirmed.
          if (
            actor.kind !== 'owner' &&
            !action.confirm &&
            code === undefined &&
            action.action !== 6 &&
            action.action !== 12
          )
            for (const event of history.slice(seen))
              if (event.entityKind === 'task' && event.entityId === t.id)
                for (const [key, change] of Object.entries(event.changes)) {
                  if (key === 'orderKey') continue;
                  // TI-095: the owner's steps are protected one by one. An
                  // unconfirmed agent may append steps and tick them, never
                  // reword, drop, reorder or untick what the owner has.
                  if (key === 'checklist' && protectedBefore.has(key)) {
                    type Step = { id: string; text: string; done: boolean };
                    const from = change.from as Step[];
                    const kept = (change.to as Step[]).filter((step) =>
                      from.some((prior) => prior.id === step.id),
                    );
                    expect(
                      kept.map((s) => ({ id: s.id, text: s.text })),
                    ).toEqual(from.map((s) => ({ id: s.id, text: s.text })));
                    for (const [i, step] of kept.entries())
                      if (from[i]!.done) expect(step.done).toBe(true);
                    continue;
                  }
                  expect(protectedBefore.has(key)).toBe(false);
                }
          // TI-095: an unconfirmed agent never changes a field the owner
          // decided on a step, and never removes a step he touched.
          if (
            actor.kind !== 'owner' &&
            !action.confirm &&
            code === undefined &&
            action.action !== 12
          )
            for (const event of history.slice(seen))
              if (event.entityKind === 'step') {
                const decided = protectedSteps.get(event.entityId);
                if (!decided) continue;
                for (const key of Object.keys(event.changes))
                  expect(decided.has(key)).toBe(false);
                if (event.changes.removedAt?.to) expect(decided.size).toBe(0);
              }
        }
        // Plan 13, criterion 1: focus keys are unique and focus mirrors the key;
        // a task that is done or archived is never on the desk.
        const keys = state.tasks.filter((x) => x.focusKey !== null);
        expect(new Set(keys.map((x) => x.focusKey)).size).toBe(keys.length);
        for (const x of state.tasks) {
          expect(x.focus).toBe(x.focusKey !== null);
          if (x.status === 'done' || x.archived) expect(x.focus).toBe(false);
          if (x.focus) expect(x.focusLeftAt).toBeNull();
        }
        // focus is set only by owner events; an agent's event carries focus
        // only as leaving the desk, when the task is finished or archived
        // (plan 13, §3.2) under confirmOwnerFields.
        // An agent's undo of its own finish or archive may put the task
        // back where the owner had it: that restores an owner decision,
        // it does not make one.
        for (const event of history)
          if (event.changes.focus?.to === true && event.actorId !== 'owner')
            expect(event.command).toBe('undo');
        for (const event of history)
          if (
            event.actorId !== 'owner' &&
            event.changes.focus &&
            event.command !== 'undo'
          ) {
            expect(event.changes.focus.to).toBe(false);
            // A task an agent creates (an accepted proposal) starts off the
            // desk: its creation does not leave it.
            if (event.changes.focus.from === null) continue;
            expect(
              event.changes.status?.to === 'done' ||
                event.changes.archived?.to === true,
            ).toBe(true);
          }
      },
    ),
    {
      numRuns: 75,
      // CI seed -1842381715: an agent accepts a proposed new task.
      examples: [
        [
          [
            { task: 0, action: 10, actor: 0, confirm: false, value: 0 },
            { task: 0, action: 11, actor: 0, confirm: false, value: 0 },
            { task: 0, action: 12, actor: 1, confirm: false, value: 0 },
          ],
        ],
      ],
    },
  );
});
