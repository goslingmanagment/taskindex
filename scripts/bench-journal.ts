// Benchmark of command cost and read cost against the length of the journal
// (plan 01, step 0 and additional step 12). Not part of vitest: run it by hand
// with `npm run bench` (node --import tsx scripts/bench-journal.ts).
//
// Regression thresholds of plan 01, section 2 (developer machine, not an SLA):
//   - task.update: ms/op at 5 020 events over ms/op at 320 events <= 1.3
//     (4.7 before the plan); absolute <= 12 ms after phase 1, <= 4 ms after
//     phase 4, at 300 tasks with 1 KB notes.
//   - at 4 000 operations and 2 000 tasks: GET /api/operations?limit=50 <= 10 ms,
//     /api/operations/{id} <= 2 ms, /api/tasks/{id}/history <= 3 ms,
//     /api/tasks/{id} <= 2 ms, /api/digest <= 25 ms.
//   - task.update at 5 000 tasks without history over 1 000 tasks <= 5.5 after
//     phase 1 and <= 2 after phase 4; /api/operations/{id} at 50 000 operations
//     <= 5 ms after step 5.
//
// Every run appends one entry to
// docs/plans/2026-09-08-v2-review/bench-baseline.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  migrate,
  generation,
  latestSeq,
  readOperations,
  withoutEvents,
  writeState,
} from '../src/server/db.js';
import { executeOperation } from '../src/server/operations.js';
import { createApp } from '../src/server/app.js';
import { defaultAppearance } from '../src/shared/domain-schemas.js';
import type {
  Actor,
  OperationResponse,
  Task,
  WorkspaceState,
} from '../src/shared/model.js';

const owner: Actor = {
  id: 'owner',
  label: 'Владелец',
  kind: 'owner',
  scope: 'write',
};
const NOTE = 'x'.repeat(1024);
const SOURCE = process.env.BENCH_SOURCE ?? 'v2-fixes A3 до плана 01';
const baselinePath = fileURLToPath(
  new URL(
    '../docs/plans/2026-09-08-v2-review/bench-baseline.json',
    import.meta.url,
  ),
);

type Result = { label: string; events: number; msPerOp: number; note?: string };
const results: Result[] = [];

function record(label: string, events: number, msPerOp: number, note?: string) {
  const entry: Result = {
    label,
    events,
    msPerOp: Number(msPerOp.toFixed(3)),
    ...(note ? { note } : {}),
  };
  results.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}

function measure(
  label: string,
  events: number,
  iterations: number,
  fn: (i: number) => void,
  note?: string,
) {
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  return record(
    label,
    events,
    (performance.now() - started) / iterations,
    note,
  );
}

async function measureAsync(
  label: string,
  events: number,
  iterations: number,
  fn: (i: number) => Promise<unknown>,
  note?: string,
) {
  const started = performance.now();
  for (let i = 0; i < iterations; i++) await fn(i);
  return record(
    label,
    events,
    (performance.now() - started) / iterations,
    note,
  );
}

const AREAS = ['agency', 'development', 'personal'] as const;
const key = (n: number) => `k${String(n).padStart(8, '0')}`;

function task(n: number): Task {
  return {
    id: `t${n}`,
    area: AREAS[n % 3]!,
    projectId: null,
    title: `Задача ${n}`,
    status: 'todo',
    note: NOTE,
    due: null,
    waitingFor: '',
    followUp: null,
    orderKey: key(n),
    focus: false,
    archived: false,
    checklist: Array.from({ length: 10 }, (_, i) => ({
      id: `t${n}s${i}`,
      text: `Шаг ${i}`,
      done: false,
    })),
    commentCount: 0,
    originSystem: null,
    originRef: null,
    originUrl: null,
    originVersion: null,
    createdBy: 'owner',
    createdByLabel: 'Владелец',
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 1,
    createdAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T12:00:00.000Z',
  };
}

// A workspace of `count` tasks written in one pass: seeding through
// executeOperation would itself be the quadratic cost under measurement.
function seedTasks(db: ReturnType<typeof openDatabase>, count: number) {
  const state: WorkspaceState = {
    projects: [],
    tasks: Array.from({ length: count }, (_, n) => task(n)),
    comments: [],
    appearance: [defaultAppearance()],
  };
  writeState(db, state);
  return state;
}

// Journal padding: copies of one event and one operation, the shape a
// task.update of a 1 KB note leaves behind. The rows belong to a task that no
// measured command touches, so they only make the journal longer. Results are
// stored the way the current code stores them (`withoutEvents`), so the
// numbers describe the live format, not a historic one.
function padJournal(
  db: ReturnType<typeof openDatabase>,
  count: number,
  withOperations: boolean,
) {
  const gen = generation(db);
  const changes = JSON.stringify({ note: { from: NOTE, to: NOTE } });
  const event = db.sqlite.prepare(
    'INSERT INTO events(at, actor_id, actor_label, operation_id, entity_kind, entity_id, task_id, command, changes, record_revision, first_seq, last_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const operation = db.sqlite.prepare(
    'INSERT INTO operations(id, operation_seq, actor_id, actor_label, command, command_hash, status, result, first_seq, last_seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const start = db.sqlite
    .prepare('SELECT COALESCE(MAX(operation_seq),0) AS n FROM operations')
    .get() as { n: number };
  db.sqlite.transaction(() => {
    for (let i = 0; i < count; i++) {
      const seq = latestSeq(db) + 1;
      const id = `pad-${start.n + i + 1}`;
      event.run(
        '2026-09-08T12:00:00.000Z',
        'owner',
        'Владелец',
        id,
        'task',
        'pad',
        null,
        'task.update',
        changes,
        i + 2,
        seq,
        seq,
      );
      if (!withOperations) continue;
      const result = {
        ok: true,
        operationId: id,
        generation: gen,
        firstSeq: seq,
        lastSeq: seq,
        results: [
          {
            record: null,
            changes: JSON.parse(changes) as Record<string, unknown>,
          },
        ],
        events: [
          {
            seq,
            generation: gen,
            at: '2026-09-08T12:00:00.000Z',
            actorId: 'owner',
            actorLabel: 'Владелец',
            operationId: id,
            entityKind: 'task',
            entityId: 'pad',
            command: 'task.update',
            changes: JSON.parse(changes) as Record<string, unknown>,
            recordRevision: i + 2,
            firstSeq: seq,
            lastSeq: seq,
          },
        ],
      };
      operation.run(
        id,
        start.n + i + 1,
        'owner',
        'Владелец',
        'task.update',
        `hash-${id}`,
        200,
        JSON.stringify(withoutEvents(result as OperationResponse)),
        seq,
        seq,
        '2026-09-08T12:00:00.000Z',
      );
    }
  })();
}

function update(
  db: ReturnType<typeof openDatabase>,
  id: string,
  revision: number,
  n: number,
) {
  const response = executeOperation(
    db,
    {
      command: 'task.update',
      payload: { id, baseRevision: revision, note: `${NOTE}${n}` },
      operationId: `bench-${id}-${n}`,
      generation: generation(db),
    },
    owner,
  );
  if (!response.body.ok) throw new Error(JSON.stringify(response.body));
  return revision + 1;
}

// 1. Command cost against journal length (plan 01, step 0).
function commandCostByJournal() {
  const db = openDatabase(':memory:');
  migrate(db);
  seedTasks(db, 300);
  let revision = 1;
  let n = 0;
  for (const target of [320, 2020, 5020, 10020]) {
    const pad = target - 20 - latestSeq(db);
    if (pad > 0) padJournal(db, pad, false);
    measure('task.update, 300 задач, заметка 1 КБ', target, 20, () => {
      revision = update(db, 't0', revision, n++);
    });
  }
  db.close();
}

// 2. Reads on a large workspace, and the Ж1 gate of plan 09 (step 13).
async function readsOnLargeWorkspace() {
  const db = openDatabase(':memory:');
  migrate(db);
  seedTasks(db, 2000);
  padJournal(db, 4000, true);
  const app = createApp({ db, authorize: () => owner });
  const events = latestSeq(db);
  const get = (path: string) => app.request(path);
  await measureAsync('GET /api/operations?limit=50', events, 20, () =>
    get('/api/operations?limit=50'),
  );
  await measureAsync('GET /api/operations/{id}', events, 20, () =>
    get('/api/operations/pad-2000'),
  );
  await measureAsync('GET /api/tasks/{id}/history', events, 20, () =>
    get('/api/tasks/t1/history'),
  );
  await measureAsync('GET /api/tasks/{id}', events, 20, () =>
    get('/api/tasks/t1'),
  );
  await measureAsync('GET /api/digest', events, 10, () => get('/api/digest'));
  await measureAsync('GET /api/snapshot', events, 10, () =>
    get('/api/snapshot'),
  );
  measure('readOperations(db)', events, 5, () => void readOperations(db));
  const size = db.sqlite
    .prepare(
      "SELECT SUM(LENGTH(result)) AS total, SUM(LENGTH(json_extract(result, '$.events'))) AS events FROM operations",
    )
    .get() as { total: number; events: number };
  record(
    'operations.result: доля events, %',
    events,
    (size.events / size.total) * 100,
    `SUM(LENGTH(result))=${size.total}, SUM(LENGTH(events))=${size.events} при 4000 операций и 2000 задач`,
  );
  app.closeStreams();
  db.close();
}

// 3. Astra (a): task.update on N tasks without any history.
function tasksWithoutHistory() {
  for (const count of [100, 1000, 5000]) {
    const db = openDatabase(':memory:');
    migrate(db);
    seedTasks(db, count);
    let revision = 1;
    let n = 0;
    measure(`task.update, ${count} задач без истории`, 0, 5, () => {
      revision = update(db, 't0', revision, n++);
    });
    db.close();
  }
}

// 4. Astra (b): one task, a long journal of copied events and operations.
function oneTaskLongJournal() {
  for (const count of [1000, 10000, 50000]) {
    const db = openDatabase(':memory:');
    migrate(db);
    seedTasks(db, 1);
    padJournal(db, count, true);
    let revision = 1;
    let n = 0;
    measure(`task.update, 1 задача, ${count} операций`, count, 5, () => {
      revision = update(db, 't0', revision, n++);
    });
    measure(`readOperations().find(), ${count} операций`, count, 3, () => {
      const found = readOperations(db).find((o) => o.id === `pad-${count}`);
      if (!found) throw new Error('операция не найдена');
    });
    db.close();
  }
}

commandCostByJournal();
await readsOnLargeWorkspace();
tasksWithoutHistory();
oneTaskLongJournal();

const baseline = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { runs: unknown[] })
  : { runs: [] };
baseline.runs.push({
  source: SOURCE,
  fixture:
    'Каждая задача: заметка 1 КБ и 10 шагов чеклиста. Журнал наращивается копиями события и операции task.update (padJournal), измеряются реальные executeOperation. Сценарии Astra «N задач без истории» здесь тяжелее исходных: у Astra задачи были без заметки и чеклиста.',
  at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  results,
});
writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(
  JSON.stringify({ written: baselinePath, runs: baseline.runs.length }),
);
