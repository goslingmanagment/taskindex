// Read-only benchmark: measures per-command latency of executeOperation as the
// events journal grows. Uses an in-memory SQLite; repository files are not touched.
import {
  openDatabase,
  migrate,
  generation,
} from '/Users/dmitriy/code/taskindex/src/server/db.ts';
import { executeOperation } from '/Users/dmitriy/code/taskindex/src/server/operations.ts';
import type { Actor } from '/Users/dmitriy/code/taskindex/src/shared/model.ts';

const db = openDatabase(':memory:');
migrate(db, { migrationsDir: '/Users/dmitriy/code/taskindex/drizzle/v2' });
const owner: Actor = {
  id: 'owner',
  label: 'Владелец',
  kind: 'owner',
  scope: 'write',
};
const gen = generation(db);
let n = 0;
const run = (command: string, payload: Record<string, unknown>) =>
  executeOperation(
    db,
    { operationId: `op-${n++}`, generation: gen, command, payload } as never,
    owner,
    {
      now: '2026-09-08T12:00:00.000Z',
    },
  );

// 300 tasks with a moderately sized note (~1 KB) and a 10-item checklist.
const note = 'х'.repeat(1000);
for (let i = 0; i < 300; i++)
  run('task.create', {
    id: `t${i}`,
    area: 'agency',
    title: `Задача ${i}`,
    note,
    checklist: Array.from({ length: 10 }, (_, k) => ({
      id: `t${i}-c${k}`,
      text: `Шаг ${k}`,
      done: false,
    })),
  });

function measure(label: string, iterations = 20) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const id = `t${i % 300}`;
    const rev = (
      db.sqlite.prepare('SELECT revision FROM tasks WHERE id=?').get(id) as {
        revision: number;
      }
    ).revision;
    const r = run('task.update', {
      id,
      baseRevision: rev,
      title: `Задача ${id} v${n}`,
    });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  const per = (performance.now() - t0) / iterations;
  const events = (
    db.sqlite.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
  ).c;
  const bytes = (
    db.sqlite.prepare('SELECT SUM(LENGTH(changes)) AS b FROM events').get() as {
      b: number;
    }
  ).b;
  console.log(
    JSON.stringify({
      label,
      events,
      changesMB: +(bytes / 1e6).toFixed(1),
      msPerCommand: +per.toFixed(1),
    }),
  );
}

measure('after 300 creates');
// Grow the journal with note edits (each event carries from/to of a 1 KB note).
for (const target of [1000, 2000, 4000]) {
  while (
    (
      db.sqlite.prepare('SELECT COUNT(*) AS c FROM events').get() as {
        c: number;
      }
    ).c < target
  ) {
    const id = `t${n % 300}`;
    const rev = (
      db.sqlite.prepare('SELECT revision FROM tasks WHERE id=?').get(id) as {
        revision: number;
      }
    ).revision;
    run('task.update', { id, baseRevision: rev, note: note + n });
  }
  measure(`journal ~${target}`);
}
// GET /api/tasks/:id path cost proxy: readState alone.
import { readState } from '/Users/dmitriy/code/taskindex/src/server/db.ts';
const t0 = performance.now();
for (let i = 0; i < 20; i++) readState(db);
console.log(
  JSON.stringify({
    label: 'readState (300 tasks, 3000 items)',
    msPerCall: +((performance.now() - t0) / 20).toFixed(1),
  }),
);
db.close();
