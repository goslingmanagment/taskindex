// Produced on main cf576a1 (schema 8 / export 7), the last revision with
// steps as rows of text, tick and position. Run from the new checkout,
// passing an unchanged checkout of that revision:
// node --import tsx tests/fixtures/export-schema-8.seed.mts /path/to/cf576a1
// Only an in-memory database is used; the output is next to this script.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = resolve(process.argv[2] ?? '.');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim();
if (!revision.startsWith('cf576a1'))
  throw new Error(
    'Pass an unchanged checkout of cf576a1, the schema-8 producer.',
  );
execFileSync(
  'git',
  ['diff', '--quiet', 'HEAD', '--', 'src', 'tests/api/helpers.ts', 'drizzle/v2'],
  { cwd: source },
);
process.chdir(source);
const { fixture, success } = (await import(
  pathToFileURL(join(source, 'tests/api/helpers.ts')).href
)) as typeof import('../api/helpers.js');
const { exportWorkspace, validateExport } = (await import(
  pathToFileURL(join(source, 'src/server/admin.ts')).href
)) as typeof import('../../src/server/admin.js');
const { setSetting } = (await import(
  pathToFileURL(join(source, 'src/server/db.ts')).href
)) as typeof import('../../src/server/db.js');

const f = fixture();
try {
  setSetting(f.db, 'generation', 'fixture-schema-8');
  // The owner writes a plan of three steps, an agent works through it, the
  // owner corrects one wording (which marks `checklist` on the task), the
  // agent reorders and a stale edit is stored as a conflict.
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'plan-task',
          area: 'development',
          title: 'Перенести бота на новый сервер',
          checklist: [
            { id: 'plan-1', text: 'Поднять контейнер', done: false },
            { id: 'plan-2', text: 'Перенести базу', done: false },
            { id: 'plan-3', text: 'Проверить мониторинг', done: false },
          ],
        },
      },
      { id: 'plan-create' },
    ),
  );
  success(
    await f.post(
      {
        command: 'checklist.update',
        payload: {
          taskId: 'plan-task',
          baseRevision: 1,
          itemId: 'plan-1',
          done: true,
        },
      },
      // Before 0008 the owner's task protected the whole checklist: the
      // agent had to confirm even a tick.
      { id: 'plan-tick', role: 'agent', confirmOwnerFields: true },
    ),
  );
  success(
    await f.post(
      {
        command: 'checklist.update',
        payload: {
          taskId: 'plan-task',
          baseRevision: 2,
          itemId: 'plan-2',
          text: 'Перенести базу и проверить бэкап',
        },
      },
      { id: 'plan-owner-edit' },
    ),
  );
  success(
    await f.post(
      {
        command: 'checklist.reorder',
        payload: {
          taskId: 'plan-task',
          baseRevision: 3,
          itemIds: ['plan-1', 'plan-3', 'plan-2'],
        },
      },
      { id: 'plan-reorder', role: 'agent', confirmOwnerFields: true },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'plain-task',
          area: 'agency',
          title: 'Без шагов',
          status: 'done',
        },
      },
      { id: 'plain-create' },
    ),
  );
  const rejected = await f.post(
    {
      command: 'checklist.add',
      payload: {
        taskId: 'plan-task',
        baseRevision: 1,
        text: 'Устаревшая ревизия',
      },
    },
    { id: 'plan-rejected', role: 'agent' },
  );
  if (rejected.status !== 409 || rejected.body.ok || !rejected.body.current)
    throw new Error(
      'Expected a stored conflict containing the task record with its steps.',
    );

  const data = exportWorkspace(f.db);
  if (Number(data.formatVersion) !== 7 || data.settings.schema_version !== '8')
    throw new Error('Producer must export format 7 and schema version 8.');
  data.exportedAt = '2026-09-18T12:00:00.000Z';
  validateExport(data);
  const target = fileURLToPath(
    new URL('./export-schema-8.json', import.meta.url),
  );
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    JSON.stringify({
      revision,
      target,
      formatVersion: data.formatVersion,
      operations: data.operations.length,
      events: data.events.length,
    }),
  );
} finally {
  f.close();
}
