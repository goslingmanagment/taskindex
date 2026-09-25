// Produced on main f2ab3d5 (schema 9 / export 8), the last revision without
// agent proposals. Run from the new checkout, passing an unchanged checkout
// of that revision:
// node --import tsx tests/fixtures/export-schema-9.seed.mts /path/to/f2ab3d5
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
if (!revision.startsWith('f2ab3d5'))
  throw new Error(
    'Pass an unchanged checkout of f2ab3d5, the schema-9 producer.',
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
  setSetting(f.db, 'generation', 'fixture-schema-9');
  // The board the night shift will audit: a past visit with the date in its
  // title, an agent's task with steps the agent works through and the owner
  // renames, an owner's comment, an archived task and a stale edit stored as
  // a conflict.
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'visit-task',
          area: 'personal',
          title: 'Стрижка 21.09',
          due: '2026-09-21',
        },
      },
      { id: 'visit-create' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'agent-task',
          area: 'development',
          title: 'Проверить отчёт ревью',
          priority: 'p1',
          checklist: [
            { id: 'agent-step-1', text: 'Прочитать отчёт' },
            { id: 'agent-step-2', text: 'Ответить на вопросы' },
          ],
        },
      },
      { id: 'agent-create', role: 'agent' },
    ),
  );
  success(
    await f.post(
      {
        command: 'checklist.update',
        payload: {
          taskId: 'agent-task',
          baseRevision: 1,
          itemId: 'agent-step-1',
          done: true,
          result: 'Девять вопросов',
        },
      },
      { id: 'agent-tick', role: 'agent' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'agent-task',
          baseRevision: 1,
          title: 'Ответить на вопросы ревью',
        },
      },
      { id: 'owner-rename' },
    ),
  );
  success(
    await f.post(
      {
        command: 'comment.add',
        payload: { id: 'owner-comment', taskId: 'agent-task', text: 'Жду' },
      },
      { id: 'owner-comment' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: { id: 'old-task', area: 'agency', title: 'Старая задача' },
      },
      { id: 'old-create' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.archive',
        payload: { id: 'old-task', baseRevision: 1 },
      },
      { id: 'old-archive' },
    ),
  );
  const rejected = await f.post(
    {
      command: 'task.update',
      payload: { id: 'agent-task', baseRevision: 1, title: 'Устаревшее имя' },
    },
    { id: 'agent-rejected', role: 'agent' },
  );
  if (rejected.status !== 409 || rejected.body.ok || !rejected.body.current)
    throw new Error('Expected a stored conflict containing the task record.');

  const data = exportWorkspace(f.db);
  if (Number(data.formatVersion) !== 8 || data.settings.schema_version !== '9')
    throw new Error('Producer must export format 8 and schema version 9.');
  data.exportedAt = '2026-09-25T12:00:00.000Z';
  validateExport(data);
  const target = fileURLToPath(
    new URL('./export-schema-9.json', import.meta.url),
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
