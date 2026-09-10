import { performance } from 'node:perf_hooks';
import { generateNKeysBetween } from 'fractional-indexing';
import {
  openDatabase,
  migrate,
  generation,
  readState,
  writeState,
  readOperations,
} from '../../../src/server/db.ts';
import { executeOperation } from '../../../src/server/operations.ts';
import type { Actor } from '../../../src/shared/model.ts';

// Isolated synthetic audit probe. No existing database, auth or network used.
const actor: Actor = {
  id: 'owner',
  label: 'Audit',
  kind: 'owner',
  scope: 'write',
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const results: unknown[] = [];
for (const count of [100, 1000, 5000]) {
  const db = openDatabase(':memory:');
  migrate(db);
  executeOperation(
    db,
    {
      generation: generation(db),
      operationId: 'seed',
      command: 'task.create',
      payload: { id: 'seed-task', area: 'agency', title: 'Audit synthetic' },
    },
    actor,
  );
  const template = readState(db).tasks[0]!;
  const keys = generateNKeysBetween(null, null, count);
  db.sqlite.transaction(() => {
    db.sqlite.exec(
      'DELETE FROM events; DELETE FROM operations; DELETE FROM tasks;',
    );
    writeState(db, {
      projects: [],
      comments: [],
      tasks: keys.map((orderKey, i) => ({
        ...template,
        id: `task-${i}`,
        orderKey,
        checklist: [],
      })),
    });
  })();
  const durations: number[] = [];
  for (let i = 0; i < 7; i++) {
    const started = performance.now();
    const result = executeOperation(
      db,
      {
        generation: generation(db),
        operationId: `change-${i}`,
        command: 'task.update',
        payload: { id: 'task-0', baseRevision: i + 1, title: `Updated ${i}` },
      },
      actor,
    );
    if (!result.body.ok) throw new Error(JSON.stringify(result.body));
    durations.push(performance.now() - started);
  }
  results.push({
    taskCount: count,
    eventCountBefore: 0,
    singleUpdateMedianMs: median(durations.slice(2)),
    timingsMs: durations,
  });
  db.close();
}

for (const count of [1000, 10000, 50000]) {
  const db = openDatabase(':memory:');
  migrate(db);
  executeOperation(
    db,
    {
      generation: generation(db),
      operationId: 'seed',
      command: 'task.create',
      payload: { id: 'seed-task', area: 'agency', title: 'Audit synthetic' },
    },
    actor,
  );
  const event = db.sqlite
    .prepare('SELECT * FROM events LIMIT 1')
    .get() as Record<string, unknown>;
  const op = db.sqlite
    .prepare('SELECT * FROM operations LIMIT 1')
    .get() as Record<string, unknown>;
  const eventSql = db.sqlite.prepare(
    `INSERT INTO events (${Object.keys(event).join(',')}) VALUES (${Object.keys(
      event,
    )
      .map(() => '?')
      .join(',')})`,
  );
  const opSql = db.sqlite.prepare(
    `INSERT INTO operations (${Object.keys(op).join(',')}) VALUES (${Object.keys(
      op,
    )
      .map(() => '?')
      .join(',')})`,
  );
  db.sqlite.transaction(() => {
    for (let i = 2; i <= count; i++) {
      const e = {
        ...event,
        seq: i,
        operation_id: `op-${i}`,
        first_seq: i,
        last_seq: i,
      };
      const o = { ...op, id: `op-${i}`, first_seq: i, last_seq: i };
      eventSql.run(...Object.values(e));
      opSql.run(...Object.values(o));
    }
  })();
  const durations: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const result = executeOperation(
      db,
      {
        generation: generation(db),
        operationId: `change-${i}`,
        command: 'task.update',
        payload: {
          id: 'seed-task',
          baseRevision: i + 1,
          title: `Updated ${i}`,
        },
      },
      actor,
    );
    if (!result.body.ok) throw new Error(JSON.stringify(result.body));
    durations.push(performance.now() - started);
  }
  const started = performance.now();
  readOperations(db).find((o) => o.id === 'seed');
  results.push({
    taskCount: 1,
    eventCountBefore: count,
    singleUpdateMedianMs: median(durations.slice(1)),
    timingsMs: durations,
    operationLookupFullScanMs: performance.now() - started,
  });
  db.close();
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      note: 'Synthetic in-memory SQLite; no network, fsync or HTTP/auth included. Seeded history is structurally representative, not a domain-valid export.',
      results,
    },
    null,
    2,
  ),
);
