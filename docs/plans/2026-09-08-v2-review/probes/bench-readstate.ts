import {
  openDatabase,
  migrate,
  generation,
  readState,
  readEvents,
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
for (let i = 0; i < 300; i++)
  executeOperation(
    db,
    {
      operationId: `op-${n++}`,
      generation: gen,
      command: 'task.create',
      payload: {
        id: `t${i}`,
        area: 'agency',
        title: `Задача ${i}`,
        note: 'х'.repeat(1000),
        checklist: Array.from({ length: 10 }, (_, k) => ({
          id: `t${i}-c${k}`,
          text: `Шаг ${k}`,
          done: false,
        })),
      },
    } as never,
    owner,
  );
for (let i = 0; i < 300; i++)
  executeOperation(
    db,
    {
      operationId: `op-${n++}`,
      generation: gen,
      command: 'comment.add',
      payload: { taskId: `t${i}`, text: 'отчёт' },
    } as never,
    owner,
  );
const time = (label: string, fn: () => unknown, k = 20) => {
  const t0 = performance.now();
  for (let i = 0; i < k; i++) fn();
  console.log(
    JSON.stringify({
      label,
      msPerCall: +((performance.now() - t0) / k).toFixed(2),
    }),
  );
};
time('readState (300 tasks, 3000 items, 300 comments)', () => readState(db));
time('readEvents (all, 620 events)', () => readEvents(db));
db.close();
