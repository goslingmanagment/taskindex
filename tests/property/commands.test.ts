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
import { agent, owner } from '../api/helpers.js';
import { defaultAppearance } from '../../src/shared/domain-schemas.js';
const actors: Actor[] = [owner, agent, { ...agent, scope: 'tasks' }];
it('random command sequences by owner and agents preserve invariants, the event projection and the owner-only policy', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          task: fc.integer({ min: 0, max: 2 }),
          action: fc.integer({ min: 0, max: 6 }),
          actor: fc.integer({ min: 0, max: 2 }),
          confirm: fc.boolean(),
          value: fc.integer({ min: 0, max: 99 }),
        }),
        { minLength: 1, maxLength: 60 },
      ),
      (actions) => {
        let state: WorkspaceState = {
          projects: [],
          tasks: [],
          comments: [],
          appearance: [defaultAppearance()],
        };
        let projection: WorkspaceState = {
          projects: [],
          tasks: [],
          comments: [],
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
          else {
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
          if (
            actor.kind !== 'owner' &&
            !action.confirm &&
            code === undefined &&
            action.action !== 6
          )
            for (const event of history.slice(seen))
              if (event.entityKind === 'task' && event.entityId === t.id)
                for (const key of Object.keys(event.changes))
                  if (key !== 'orderKey')
                    expect(protectedBefore.has(key)).toBe(false);
        }
        // focus only ever changes by owner events; agent events never carry it.
        for (const event of history)
          if (event.changes.focus) expect(event.actorId).toBe('owner');
        for (const event of history)
          if (event.actorId !== 'owner')
            expect(event.changes.focus).toBeUndefined();
      },
    ),
    { numRuns: 75 },
  );
});
