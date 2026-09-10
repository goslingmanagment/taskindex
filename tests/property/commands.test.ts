import { it, expect } from 'vitest';
import fc from 'fast-check';
import {
  applyCommand,
  applyEvent,
  assertInvariants,
} from '../../src/shared/commands.js';
import type {
  Command,
  DomainEvent,
  WorkspaceState,
} from '../../src/shared/model.js';
import { owner } from '../api/helpers.js';
it('random command sequences preserve invariants and have the same event projection', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          task: fc.integer({ min: 0, max: 2 }),
          action: fc.integer({ min: 0, max: 5 }),
          value: fc.integer({ min: 0, max: 99 }),
        }),
        { minLength: 1, maxLength: 60 },
      ),
      (actions) => {
        let state: WorkspaceState = { projects: [], tasks: [], comments: [] };
        let projection: WorkspaceState = {
          projects: [],
          tasks: [],
          comments: [],
        };
        const history: DomainEvent[] = [];
        let ids = 0;
        const apply = (command: Command) => {
          const before = structuredClone(state);
          const app = applyCommand(state, command, {
            now: '2026-09-08T12:00:00.000Z',
            actor: owner,
            ids: () => `id-${ids++}`,
            history,
          });
          state = app.state;
          const start = history.length + 1;
          const last = start + app.effects.length - 1;
          for (const effect of app.effects) {
            const event: DomainEvent = {
              ...effect,
              seq: history.length + 1,
              generation: 'g',
              at: '2026-09-08T12:00:00.000Z',
              actorId: owner.id,
              actorLabel: owner.label,
              operationId: `op-${start}`,
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
        };
        for (let i = 0; i < 3; i++)
          apply({
            command: 'task.create',
            payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
          });
        for (const action of actions) {
          const t = state.tasks[action.task]!;
          const base = { id: t.id, baseRevision: t.revision };
          if (action.action === 0)
            apply({
              command: 'task.update',
              payload: { ...base, note: `N${action.value}` },
            });
          else if (action.action === 1)
            apply({
              command: 'task.move',
              payload: {
                ...base,
                status: ['todo', 'doing', 'waiting', 'done'][
                  action.value % 4
                ] as 'todo' | 'doing' | 'waiting' | 'done',
              },
            });
          else if (action.action === 2)
            apply({
              command: t.archived ? 'task.restore' : 'task.archive',
              payload: base,
            });
          else if (action.action === 3)
            apply({
              command: 'task.update',
              payload: { ...base, focus: action.value % 2 === 0 },
            });
          else if (action.action === 4)
            apply({
              command: 'comment.add',
              payload: { taskId: t.id, text: `Comment ${action.value}` },
            });
          else
            apply({
              command: 'checklist.add',
              payload: {
                taskId: t.id,
                baseRevision: t.revision,
                text: `Step ${action.value}`,
              },
            });
        }
      },
    ),
    { numRuns: 75 },
  );
});
