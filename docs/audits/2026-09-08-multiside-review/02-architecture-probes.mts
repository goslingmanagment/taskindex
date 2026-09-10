// Run from repository root with Node 24 and --import tsx.
// Uses only in-memory databases and synthetic records; no application data or env.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openDatabase, migrate, generation, readState } from '../../../src/server/db.ts';
import { executeOperation } from '../../../src/server/operations.ts';
import { exportWorkspace, importWorkspace } from '../../../src/server/admin.ts';
import { createApp } from '../../../src/server/app.ts';
import { WorkspaceStore } from '../../../src/web/app/store.ts';
import { ApiError } from '../../../src/web/app/api.ts';
import { taskSaveCommand } from '../../../src/web/lib/use-workspace.ts';
import type { OperationEnvelope, OperationSuccess, Actor } from '../../../src/shared/model.ts';

const actor: Actor = { id: 'owner', label: 'Synthetic Owner', kind: 'owner', scope: 'write' };
const output: Record<string, unknown> = { runtime: process.version };
class Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(i: number) { return [...this.values.keys()][i] ?? null; }
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { this.values.set(k, v); }
  removeItem(k: string) { this.values.delete(k); }
}
{
  const db = openDatabase(':memory:');
  migrate(db);
  const gen = generation(db);
  executeOperation(db, { operationId: 'create-task', generation: gen, command: 'task.create', payload: { id: 'task-1', area: 'agency', title: 'Original' } }, actor);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const storage = new Storage();
  const store = new WorkspaceStore(async <T>(_path: string, init?: RequestInit): Promise<T> => {
    const envelope = JSON.parse(String(init?.body)) as OperationEnvelope;
    if (envelope.operationId === 'delayed-move') await delayed;
    const result = executeOperation(db, envelope, actor);
    if (!result.body.ok) throw new ApiError(result.body, result.status);
    return result.body as T;
  }, storage);
  const state = readState(db);
  store.loadSnapshot({ generation: gen, seq: 1, today: '2026-09-08', timezone: 'Europe/Moscow', tasks: state.tasks, projects: state.projects });
  const first = store.submit({ command: 'task.move', payload: { id: 'task-1', baseRevision: 1, status: 'doing' } }, 'delayed-move');
  const projected = store.getSnapshot().data.tasks[0]!;
  const editorBase = structuredClone(projected);
  const edit = { ...editorBase, note: 'Second user edit' };
  const before = { confirmedRevision: store.getSnapshot().confirmed.tasks[0]!.revision, editorBaseRevision: editorBase.revision, pendingIds: store.getSnapshot().pending.map((p) => p.envelope.operationId) };
  let rejected: unknown;
  try { await store.submit(taskSaveCommand(edit, editorBase), 'dependent-editor-save'); }
  catch (error) { rejected = error instanceof ApiError ? { status: error.status, detail: error.detail } : String(error); }
  release();
  const accepted = await first;
  assert.equal(editorBase.revision, 2);
  assert.equal((rejected as { detail: { code: string } }).detail.code, 'invalid');
  assert.equal(readState(db).tasks[0]!.note, '');
  output.optimisticRevisionUsedAsPrecondition = { before, rejected, firstAccepted: accepted.ok, after: readState(db).tasks[0], unresolvedStorage: [...storage.values.keys()] };
  db.close();
}
{
  const db = openDatabase(':memory:');
  const target = openDatabase(':memory:');
  migrate(db); migrate(target);
  const gen = generation(db);
  executeOperation(db, { operationId: 'create-before-data-migration', generation: gen, command: 'task.create', payload: { id: 'task-1', area: 'agency', title: 'Original' } }, actor);
  const before = exportWorkspace(db);
  importWorkspace(target, before);
  // Simulate only the data-transform part of a future SQL migration, not a
  // corruption of a real database. Adding a new required field has the same
  // replay/strict-contract requirement; that future migration is not implemented.
  db.sqlite.prepare('UPDATE tasks SET note=? WHERE id=?').run('Migration default', 'task-1');
  const app = createApp({ db, authorize: () => actor });
  const health = await (await app.request('/health')).json();
  const after = exportWorkspace(db);
  let rejection: unknown;
  try { importWorkspace(target, after, { replace: true }); }
  catch (error) { rejection = { name: (error as Error).name, message: (error as Error).message }; }
  assert.match((rejection as { message: string }).message, /состояние записей не совпадает с журналом/);
  output.rowOnlyDataMigrationContract = { healthy: health, generationUnchanged: generation(db) === gen, exportProduced: true, importRejected: rejection, classification: 'Architectural risk for future data/schema migrations; deliberately simulated row-only transform, not a present v1 corruption.' };
  app.closeStreams(); db.close(); target.close();
}
writeFileSync('docs/audits/2026-09-08-multiside-review/02-architecture-probes.json', JSON.stringify(output, null, 2) + '\n');
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
