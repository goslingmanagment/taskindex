// Produced on main dc37568 (schema 6 / export 5), the last revision with the
// label otvet in the catalogue. Run from the new checkout, passing an
// unchanged checkout of that revision:
// node --import tsx tests/fixtures/export-schema-6.seed.mts /path/to/dc37568
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
if (!revision.startsWith('dc37568'))
  throw new Error(
    'Pass an unchanged checkout of dc37568, the schema-6 producer.',
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
  setSetting(f.db, 'generation', 'fixture-schema-6');
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'labelled-task',
          area: 'agency',
          title: 'Ответить кандидату на ночную смену',
          labels: ['otvet', 'ari'],
        },
      },
      { id: 'label-create' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'labelled-task',
          baseRevision: 1,
          labels: ['lora', 'otvet', 'ari'],
          note: 'Ждёт ответа',
        },
      },
      { id: 'label-update' },
    ),
  );
  success(
    await f.post(
      {
        command: 'task.create',
        payload: {
          id: 'answered-task',
          area: 'agency',
          title: 'Только метка ответ',
          labels: ['otvet'],
          status: 'done',
        },
      },
      { id: 'label-only' },
    ),
  );
  const rejected = await f.post(
    {
      command: 'task.update',
      payload: {
        id: 'labelled-task',
        baseRevision: 1,
        note: 'Конфликтующая заметка',
      },
    },
    { id: 'label-rejected' },
  );
  if (rejected.status !== 409 || rejected.body.ok || !rejected.body.current)
    throw new Error(
      'Expected a stored conflict containing the labelled task record.',
    );

  const data = exportWorkspace(f.db);
  if (Number(data.formatVersion) !== 5 || data.settings.schema_version !== '6')
    throw new Error('Producer must export format 5 and schema version 6.');
  data.exportedAt = '2026-09-17T00:00:00.000Z';
  validateExport(data);
  const target = fileURLToPath(
    new URL('./export-schema-6.json', import.meta.url),
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
