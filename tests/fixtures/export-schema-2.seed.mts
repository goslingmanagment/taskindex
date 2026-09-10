// Seeds a workspace on the code of schema version 2 (migrations 0000, 0001;
// export formatVersion 1) and writes tests/fixtures/export-schema-2.json.
// Run once on that code: node --import tsx tests/fixtures/export-schema-2.seed.mts
// The file is the "previous version" fixture for tests/api/migration-compat.test.ts;
// regenerate it only when a new schema version becomes the previous one.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixture, success } from '../api/helpers.js';
import { createAgent, exportWorkspace } from '../../src/server/admin.js';
const f = fixture();
createAgent(f.db, { id: 'test-agent', label: 'Тестовый агент' });
const step = async (...args: Parameters<typeof f.post>) => {
  const r = await f.post(...args);
  console.log(args[1]?.id, r.status, r.body.ok ? 'ok' : (r.body as { code: string }).code);
  return r;
};
success(
  await step(
    {
      command: 'task.create',
      payload: {
        id: 't1',
        area: 'agency',
        title: 'Задача',
        checklist: [{ id: 's1', text: 'Первый шаг', done: false }],
      },
    },
    { id: 'op-01-create' },
  ),
);
success(
  await step(
    {
      command: 'project.create',
      payload: { id: 'p1', area: 'agency', name: 'Маркетинг', color: '#112233' },
    },
    { id: 'op-02-project' },
  ),
);
success(
  await step(
    {
      command: 'task.update',
      payload: { id: 't1', baseRevision: 1, title: 'Задача (правка)', note: 'Заметка', projectId: 'p1' },
    },
    { id: 'op-03-edit' },
  ),
);
success(
  await step(
    { command: 'comment.add', payload: { taskId: 't1', id: 'c1', text: 'Отчёт агента' } },
    { id: 'op-04-comment', role: 'agent' },
  ),
);
success(
  await step(
    { command: 'checklist.add', payload: { taskId: 't1', baseRevision: 2, id: 's2', text: 'Второй шаг' } },
    { id: 'op-05-checklist' },
  ),
);
success(
  await step(
    {
      command: 'task.sync',
      payload: {
        origin: { system: 'tg', ref: '42', url: 'https://t.me/c/42', version: '1' },
        fields: { area: 'development', title: 'Из источника', note: 'Версия 1' },
      },
    },
    { id: 'op-06-sync', role: 'agent' },
  ),
);
success(
  await step(
    {
      command: 'task.sync',
      payload: {
        origin: { system: 'tg', ref: '42', version: '1' },
        fields: { area: 'development', title: 'Устаревшая версия' },
      },
    },
    { id: 'op-07-sync-stale', role: 'agent' },
  ),
);
success(
  await step(
    { command: 'task.update', payload: { id: 't1', baseRevision: 3, title: 'Задача (правка)' } },
    { id: 'op-08-noop' },
  ),
);
const rejected = await step(
  { command: 'task.create', payload: { id: 't1', area: 'agency', title: 'Дубль' } },
  { id: 'op-09-rejected' },
);
if (rejected.status !== 409) throw new Error('expected a stored rejection');
const batch = await f.batch(
  [
    { command: 'task.move', payload: { id: 't1', baseRevision: 3, status: 'doing' } },
    { command: 'checklist.update', payload: { taskId: 't1', baseRevision: 4, itemId: 's1', done: true } },
  ],
  { id: 'op-10-batch' },
);
console.log('op-10-batch', batch.status, batch.body.ok);
success(batch);
success(await step({ command: 'undo', payload: { operationId: 'op-10-batch' } }, { id: 'op-11-undo' }));
success(
  await step(
    { command: 'comment.add', payload: { taskId: 't1', id: 'c2', text: 'Ответ владельца агенту' } },
    { id: 'op-12-owner-comment' },
  ),
);
const data = exportWorkspace(f.db);
const target = fileURLToPath(new URL('./export-schema-2.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
console.log('written', target, 'formatVersion', data.formatVersion, 'schema_version', data.settings.schema_version, 'operations', data.operations.length, 'events', data.events.length);
f.close();
