// Produced on main 0901fd2 (schema 5 / export 4), before TI-086 adds fields.
// Run from the new checkout, passing an unchanged checkout of that revision:
// node --import tsx tests/fixtures/export-schema-5.seed.mts /path/to/0901fd2
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
if (!revision.startsWith('0901fd2'))
  throw new Error(
    'Pass an unchanged checkout of 0901fd2, the schema-5 producer.',
  );
execFileSync(
  'git',
  [
    'diff',
    '--quiet',
    'HEAD',
    '--',
    'src',
    'tests/api/helpers.ts',
    'drizzle/v2',
  ],
  {
    cwd: source,
  },
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
  setSetting(f.db, 'generation', 'fixture-schema-5');
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'old-task',
          area: 'agency',
          title: 'Задача до появления приоритета',
          checklist: [
            { id: 'old-step', text: 'Сохранить историю', done: false },
          ],
        },
      },
      { id: 'old-create' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'old-task',
          baseRevision: 1,
          note: 'Старая заметка',
          focus: true,
        },
      },
      { id: 'old-update' },
    ),
  );
  success(
    await f.post(
      {
        command: 'appearance.update',
        payload: { baseRevision: 1, mode: 'dark', skinId: 'focus' },
      },
      { id: 'old-appearance' },
    ),
  );
  const rejected = await f.post(
    {
      command: 'task.update',
      payload: {
        id: 'old-task',
        baseRevision: 1,
        note: 'Конфликтующая заметка',
      },
    },
    { id: 'old-rejected' },
  );
  if (rejected.status !== 409 || rejected.body.ok || !rejected.body.current)
    throw new Error(
      'Expected a stored conflict containing the old task record.',
    );

  const data = exportWorkspace(f.db);
  if (Number(data.formatVersion) !== 4 || data.settings.schema_version !== '5')
    throw new Error('Producer must export format 4 and schema version 5.');
  data.exportedAt = '2026-09-13T00:00:00.000Z';
  validateExport(data);
  const target = fileURLToPath(
    new URL('./export-schema-5.json', import.meta.url),
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
