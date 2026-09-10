import { it, expect } from 'vitest';
import fc from 'fast-check';
import SQLite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  readState,
  generation,
} from '../../src/server/db.js';
import { createProjection } from '../../src/server/projection.js';
import { executeOperation } from '../../src/server/operations.js';
import type { Command } from '../../src/shared/model.js';
import { owner } from '../api/helpers.js';
// Plan 01, test 8: the cached projection equals a fresh readState after every
// command through the executor, and a commit by another connection (an admin
// command, sqlite3 in the container) drops the cache through data_version.
it('projection.read() equals readState after random commands and after an external write', () => {
  const root = mkdtempSync(join(tmpdir(), 'taskindex-projection-'));
  try {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            task: fc.integer({ min: 0, max: 2 }),
            action: fc.integer({ min: 0, max: 4 }),
            value: fc.integer({ min: 0, max: 99 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (actions) => {
          const path = join(root, `${Math.random().toString(36).slice(2)}.db`);
          const db = openDatabase(path);
          migrate(db);
          const projection = createProjection(db);
          let n = 0;
          const run = (command: Command) => {
            executeOperation(
              db,
              {
                ...command,
                operationId: `0000-0000-0000-0000-${n++}`,
                generation: generation(db),
              },
              owner,
              { projection },
            );
            expect(projection.read()).toEqual(readState(db));
            expect(projection.read()).toBe(projection.read());
          };
          for (let i = 0; i < 3; i++)
            run({
              command: 'task.create',
              payload: { id: `t${i}`, area: 'agency', title: `T${i}` },
            });
          for (const action of actions) {
            const t = projection.read().tasks[action.task]!;
            const base = { id: t.id, baseRevision: t.revision };
            if (action.action === 0)
              run({
                command: 'task.update',
                payload: { ...base, note: `N${action.value}` },
              });
            else if (action.action === 1)
              run({
                command: 'task.move',
                payload: {
                  ...base,
                  status: ['todo', 'doing', 'waiting', 'done'][
                    action.value % 4
                  ] as 'todo' | 'doing' | 'waiting' | 'done',
                },
              });
            else if (action.action === 2)
              run({
                command: 'comment.add',
                payload: { taskId: t.id, text: `C${action.value}` },
              });
            else if (action.action === 3)
              run({
                command: 'checklist.add',
                payload: {
                  taskId: t.id,
                  baseRevision: t.revision,
                  text: `S${action.value}`,
                },
              });
            else
              run({
                command: 'undo',
                payload: { operationId: `0000-0000-0000-0000-${n - 1}` },
              });
          }
          // Another connection commits: the next read sees it.
          const cached = projection.read();
          const other = new SQLite(path);
          other
            .prepare("UPDATE tasks SET title = 'external' WHERE id = 't0'")
            .run();
          other.close();
          const fresh = projection.read();
          expect(fresh).not.toBe(cached);
          expect(fresh.tasks.find((t) => t.id === 't0')?.title).toBe(
            'external',
          );
          expect(fresh).toEqual(readState(db));
          // A write on this connection outside the executor (import, tests)
          // is seen too: total_changes moves.
          db.sqlite
            .prepare("UPDATE tasks SET title = 'internal' WHERE id = 't1'")
            .run();
          expect(
            projection.read().tasks.find((t) => t.id === 't1')?.title,
          ).toBe('internal');
          db.close();
        },
      ),
      { numRuns: 15 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
