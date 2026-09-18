import { it, expect } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import {
  openDatabase,
  migrate,
  readState,
  writeState,
  touchedByEvents,
} from '../../src/server/db.js';
import { applyCommand } from '../../src/shared/commands.js';
import { DomainError } from '../../src/shared/errors.js';
import type {
  Command,
  DomainEvent,
  WorkspaceState,
} from '../../src/shared/model.js';
import { defaultAppearance } from '../../src/shared/domain-schemas.js';
import { SEEDED_LABELS } from '../../src/shared/labels.js';
import { agent, owner } from '../api/helpers.js';
const actors = [owner, agent];
// Plan 01, test 4: writing only the records the effects name leaves the same
// database as writing the JSON diff of the whole state.
it('writeState by touched entities equals writeState by full diff after every random command', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          task: fc.integer({ min: 0, max: 2 }),
          action: fc.integer({ min: 0, max: 9 }),
          actor: fc.integer({ min: 0, max: 1 }),
          value: fc.integer({ min: 0, max: 99 }),
        }),
        { minLength: 1, maxLength: 40 },
      ),
      (actions) => {
        const byDiff = openDatabase(':memory:');
        const byEffects = openDatabase(':memory:');
        migrate(byDiff);
        migrate(byEffects);
        let state: WorkspaceState = {
          projects: [],
          labels: structuredClone(SEEDED_LABELS),
          tasks: [],
          steps: [],
          comments: [],
          appearance: [defaultAppearance()],
        };
        const history: DomainEvent[] = [];
        let ids = 0;
        let tick = 0;
        const apply = (command: Command, actor = owner) => {
          const now = new Date(
            Date.UTC(2026, 8, 8, 12, 0, tick++),
          ).toISOString();
          const operationId = `op-${randomUUID()}`;
          let app;
          try {
            app = applyCommand(state, command, {
              now,
              actor,
              ids: () => `id-${ids++}`,
              history,
              operationId,
            });
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            return;
          }
          const events: DomainEvent[] = app.effects.map((effect, n) => ({
            ...effect,
            seq: history.length + n + 1,
            generation: 'g',
            at: now,
            actorId: actor.id,
            actorLabel: actor.label,
            operationId,
            firstSeq: history.length + 1,
            lastSeq: history.length + app.effects.length,
          }));
          byDiff.sqlite.transaction(() => {
            writeState(byDiff, app.state, state);
          })();
          byEffects.sqlite.transaction(() => {
            writeState(byEffects, app.state, state, touchedByEvents(events));
          })();
          history.push(...events);
          state = app.state;
          expect(readState(byEffects)).toEqual(readState(byDiff));
          expect(readState(byEffects)).toEqual(state);
        };
        apply({
          command: 'project.create',
          payload: { id: 'p', area: 'agency', name: 'P', color: '#123456' },
        });
        for (let i = 0; i < 3; i++)
          apply({
            command: 'task.create',
            payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
          });
        for (const action of actions) {
          const actor = actors[action.actor]!;
          const t = state.tasks[action.task]!;
          const base = { id: t.id, baseRevision: t.revision };
          switch (action.action) {
            case 0:
              apply(
                {
                  command: 'task.update',
                  payload: { ...base, note: `N${action.value}` },
                },
                actor,
              );
              break;
            case 1:
              apply(
                {
                  command: 'task.move',
                  payload: {
                    ...base,
                    status: ['todo', 'doing', 'waiting', 'done'][
                      action.value % 4
                    ] as 'todo' | 'doing' | 'waiting' | 'done',
                    ...(action.value % 3 === 0 && state.tasks[0]!.id !== t.id
                      ? { before: state.tasks[0]!.id }
                      : {}),
                  },
                },
                actor,
              );
              break;
            case 2:
              apply(
                {
                  command: t.archived ? 'task.restore' : 'task.archive',
                  payload: base,
                },
                actor,
              );
              break;
            case 3:
              apply({
                command: 'task.update',
                payload: { ...base, focus: action.value % 2 === 0 },
              });
              break;
            case 4:
              apply(
                {
                  command: 'comment.add',
                  payload: { taskId: t.id, text: `Comment ${action.value}` },
                },
                actor,
              );
              break;
            case 5:
              apply(
                {
                  command: 'checklist.add',
                  payload: {
                    taskId: t.id,
                    baseRevision: t.revision,
                    text: `Step ${action.value}`,
                  },
                },
                actor,
              );
              break;
            case 6: {
              const last = history.at(-1)?.operationId;
              if (last)
                apply({ command: 'undo', payload: { operationId: last } });
              break;
            }
            case 7:
              apply({
                command: 'project.update',
                payload: {
                  id: 'p',
                  baseRevision: state.projects[0]!.revision,
                  name: `P${action.value}`,
                },
              });
              break;
            case 8:
              apply({
                command: 'appearance.update',
                payload: {
                  baseRevision: state.appearance[0]!.revision,
                  mode: action.value % 2 ? 'dark' : 'light',
                },
              });
              break;
            default: {
              const comment = state.comments.find((c) => !c.deletedAt);
              if (comment)
                apply({
                  command: 'comment.remove',
                  payload: { commentId: comment.id },
                });
              apply(
                {
                  command: 'task.sync',
                  payload: {
                    origin: {
                      system: 'src',
                      ref: `r${action.task}`,
                      version: String(action.value),
                    },
                    fields: {
                      area: 'agency',
                      title: `Synced ${action.value}`,
                      projectId: action.value % 2 ? 'p' : null,
                    },
                  },
                },
                agent,
              );
            }
          }
        }
        byDiff.close();
        byEffects.close();
      },
    ),
    { numRuns: 40 },
  );
});
