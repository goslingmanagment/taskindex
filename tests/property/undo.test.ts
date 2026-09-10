import { it, expect } from 'vitest';
import fc from 'fast-check';
import { applyCommand, isSubjectField } from '../../src/shared/commands.js';
import type {
  Command,
  DomainEvent,
  Task,
  WorkspaceState,
} from '../../src/shared/model.js';
import { owner } from '../api/helpers.js';
it('undo of generated multi-command net effects restores every subject field without decreasing revisions', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          task: fc.integer({ min: 0, max: 2 }),
          action: fc.integer({ min: 0, max: 3 }),
          value: fc.integer({ min: 1, max: 1000 }),
        }),
        { minLength: 1, maxLength: 30 },
      ),
      (actions) => {
        let state: WorkspaceState = { tasks: [], projects: [], comments: [] };
        const history: DomainEvent[] = [];
        let counter = 0;
        function apply(command: Command, operationId: string) {
          const result = applyCommand(state, command, {
            now: '2026-09-08T12:00:00.000Z',
            actor: owner,
            ids: () => `id-${counter++}`,
            history,
          });
          state = result.state;
          const firstSeq = history.length + 1;
          for (const effect of result.effects)
            history.push({
              ...effect,
              generation: 'g',
              seq: history.length + 1,
              at: '2026-09-08T12:00:00.000Z',
              actorId: owner.id,
              actorLabel: owner.label,
              operationId,
              firstSeq,
              lastSeq: firstSeq + result.effects.length - 1,
            });
        }
        for (let i = 0; i < 3; i++)
          apply(
            {
              command: 'task.create',
              payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
            },
            `create-${i}`,
          );
        const subject = (task: Task) =>
          Object.fromEntries(
            Object.entries(task).filter(([key]) => isSubjectField('task', key)),
          );
        const before = state.tasks.map(subject);
        for (const { task: which, action, value } of actions) {
          const t = state.tasks[which]!;
          const base = { id: t.id, baseRevision: t.revision };
          if (action === 0)
            apply(
              {
                command: 'task.update',
                payload: { ...base, note: `note ${value}` },
              },
              'batch',
            );
          else if (action === 1)
            apply(
              {
                command: 'task.move',
                payload: { ...base, status: value % 2 ? 'done' : 'waiting' },
              },
              'batch',
            );
          else if (action === 2)
            apply(
              {
                command: 'task.update',
                payload: {
                  ...base,
                  due: `2026-09-${String((value % 28) + 1).padStart(2, '0')}`,
                },
              },
              'batch',
            );
          else
            apply(
              {
                command: 'task.update',
                payload: { ...base, title: `Title ${value}` },
              },
              'batch',
            );
        }
        const revisions = state.tasks.map((t) => t.revision);
        apply({ command: 'undo', payload: { operationId: 'batch' } }, 'undo');
        expect(state.tasks.map(subject)).toEqual(before);
        state.tasks.forEach((task, i) =>
          expect(task.revision).toBeGreaterThanOrEqual(revisions[i]!),
        );
      },
    ),
    { numRuns: 75 },
  );
});
