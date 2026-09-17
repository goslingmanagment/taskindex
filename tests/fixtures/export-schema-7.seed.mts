// Produced on main c3c4194 (schema 7 / export 6), the last revision with the
// label catalogue in code. Run from the new checkout, passing an unchanged
// checkout of that revision:
// node --import tsx tests/fixtures/export-schema-7.seed.mts /path/to/c3c4194
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
if (!revision.startsWith('c3c4194'))
  throw new Error(
    'Pass an unchanged checkout of c3c4194, the schema-7 producer.',
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
  setSetting(f.db, 'generation', 'fixture-schema-7');
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'model-task',
          area: 'agency',
          title: 'Обновить бренд Lora',
          labels: ['lora', 'dengi'],
        },
      },
      { id: 'catalogue-create' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'model-task',
          baseRevision: 1,
          labels: ['ari', 'lora'],
          note: 'Метки из каталога в коде',
        },
      },
      { id: 'catalogue-update' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'quick-task',
          area: 'agency',
          title: 'Пять минут',
          labels: ['5-min'],
          status: 'done',
        },
      },
      { id: 'catalogue-done' },
    ),
  );
  const rejected = await f.post(
    {
      command: 'task.update',
      payload: {
        id: 'model-task',
        baseRevision: 1,
        note: 'Конфликтующая заметка',
      },
    },
    { id: 'catalogue-rejected' },
  );
  if (rejected.status !== 409 || rejected.body.ok || !rejected.body.current)
    throw new Error(
      'Expected a stored conflict containing the labelled task record.',
    );

  const data = exportWorkspace(f.db);
  if (Number(data.formatVersion) !== 6 || data.settings.schema_version !== '7')
    throw new Error('Producer must export format 6 and schema version 7.');
  data.exportedAt = '2026-09-17T21:00:00.000Z';
  validateExport(data);
  const target = fileURLToPath(
    new URL('./export-schema-7.json', import.meta.url),
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
