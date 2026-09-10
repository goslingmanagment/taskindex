import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, success } from '../../../tests/api/helpers.ts';
import { openDatabase, migrate, generation } from '../../../src/server/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { createAuth } from '../../../src/server/auth.ts';
import { createOwner, createAgent, createAgentKey, revokeAgentKey } from '../../../src/server/admin.ts';
import { ApiClient, exitCode } from '../../../src/cli/client.ts';
import { Outbox } from '../../../src/cli/outbox.ts';
import { WorkspaceStore } from '../../../src/web/app/store.ts';
import type { Snapshot } from '../../../src/shared/model.ts';

const results: unknown[] = [];
function record(name: string, details: unknown) {
  results.push({ name, details });
  console.log(JSON.stringify({ probe: name, details }));
}

// Every database here is independent :memory:, never data/ or the real server.
{
  const f = fixture();
  const old = await (await f.app.request('/api/snapshot')).json() as Snapshot;
  let releaseSnapshot!: (snapshot: Snapshot) => void;
  const requests: string[] = [];
  const delayedSnapshot = new Promise<Snapshot>((resolve) => { releaseSnapshot = resolve; });
  const store = new WorkspaceStore(async <T>(path: string): Promise<T> => {
    requests.push(path);
    if (path === '/api/snapshot') return await delayedSnapshot as T;
    return await (await f.app.request(path)).json() as T;
  }, undefined, async () => {});
  store.loadSnapshot(old);
  store.setConnected(true);
  const refreshing = store.refresh();
  const created = success(await f.post({ command: 'task.create', payload: { id: 'refresh-race', title: 'Received live', area: 'agency' } }));
  store.ingest(created.events);
  const afterEvent = { seq: store.getSnapshot().seq, tasks: store.getSnapshot().confirmed.tasks.length };
  releaseSnapshot(old);
  await refreshing;
  const afterSnapshot = { seq: store.getSnapshot().seq, tasks: store.getSnapshot().confirmed.tasks.length, connected: store.getSnapshot().connected };
  assert.equal(afterEvent.seq, 1);
  assert.equal(afterSnapshot.seq, 0);
  assert.equal(afterSnapshot.tasks, 0);
  assert.deepEqual(requests, ['/api/snapshot']);
  record('refresh-rolls-back-live-event', { afterEvent, afterSnapshot, requests });
  f.close();
}

{
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-review-cli-'));
  const outbox = new Outbox({ XDG_STATE_HOME: directory });
  const client = new ApiClient({
    baseUrl: 'https://taskindex.test', token: 'fixture-token', outbox,
    fetch: async () => new Response(JSON.stringify({ status: 'maintenance' }), { status: 200 }),
    sleep: async () => {},
  });
  const id = 'unexpected-json-response';
  const reply = await client.send({ formatVersion: 1, baseUrl: client.baseUrl, endpoint: '/api/commands', envelope: { operationId: id, generation: 'test-generation', command: 'task.create', payload: { title: 'Unconfirmed', area: 'agency' } } });
  const saved = await outbox.get(id);
  assert.equal(exitCode(reply), 0);
  assert.equal(saved, undefined);
  record('cli-deletes-outbox-without-operation-result', { reply, exitCode: exitCode(reply), outboxExists: !!saved, isolatedDirectory: directory });
}

{
  const f = fixture();
  await f.post({ command: 'task.create', payload: { id: 'existing', title: 'Initial', area: 'agency' } }, { id: 'initial' });
  const noop = await f.post({ command: 'task.update', payload: { id: 'existing', baseRevision: 1, title: 'Initial' } }, { id: 'no-effect' });
  const rejected = await f.post({ command: 'task.create', payload: { id: 'existing', title: 'Duplicate ID', area: 'agency' } }, { id: 'rejected' });
  const activity = await (await f.app.request('/api/operations')).json() as { items: { id: string }[] };
  const filtered = await (await f.app.request('/api/operations?since=0')).json() as { items: { id: string }[] };
  const digest = await (await f.app.request('/api/digest?since=0')).json() as { operations: { items: { id: string }[] } };
  const activityIds = activity.items.map((i) => i.id);
  const filteredIds = filtered.items.map((i) => i.id);
  const digestIds = digest.operations.items.map((i) => i.id);
  assert(activityIds.includes('no-effect') && activityIds.includes('rejected'));
  assert(!filteredIds.includes('no-effect') && !filteredIds.includes('rejected'));
  assert(!digestIds.includes('no-effect') && !digestIds.includes('rejected'));
  record('digest-and-since-exclude-no-event-operations', { noop, rejected, activityIds, filteredIds, digestIds });
  f.close();
}

{
  const f = fixture();
  await f.post({ command: 'task.create', payload: { id: 'checklist-limit', title: 'Checklist limit', area: 'agency', checklist: Array.from({ length: 100 }, (_, i) => ({ id: `step-${i}`, text: `Step ${i}`, done: false })) } });
  const envelopeId = 'invariant-rejection';
  const failed = await f.post({ command: 'checklist.add', payload: { taskId: 'checklist-limit', baseRevision: 1, id: 'step-101', text: 'Exceeds limit' } }, { id: envelopeId });
  const operationGet = await f.app.request(`/api/operations/${envelopeId}`);
  const reused = await f.post({ command: 'task.update', payload: { id: 'checklist-limit', baseRevision: 1, title: 'Different command reused rejected ID' } }, { id: envelopeId });
  assert.equal(failed.status, 400);
  assert.equal(operationGet.status, 404);
  assert.equal(reused.status, 200);
  record('invariant-rejection-is-not-idempotently-recorded', { failed, operationGetStatus: operationGet.status, reusedStatus: reused.status, reusedOk: reused.body.ok });
  f.close();
}

{
  const db = openDatabase(':memory:');
  migrate(db);
  await createOwner(db, { email: 'owner@example.test', password: 'isolated-test-password' });
  createAgent(db, { id: 'reader', label: 'Reader' });
  createAgent(db, { id: 'writer', label: 'Writer' });
  const baseURL = 'https://taskindex.test';
  const auth = createAuth(db, { baseURL, secret: 'isolated-probe-secret-with-more-than-32-characters' });
  const reader = await createAgentKey(db, auth, { agentId: 'reader', scope: 'read' });
  const writer = await createAgentKey(db, auth, { agentId: 'writer', scope: 'write' });
  const app = createApp({ db, auth, baseURL });
  const response = await app.request(`/api/events/stream?generation=${generation(db)}&since=0`, { headers: { authorization: `Bearer ${reader.key}` } });
  assert.equal(response.status, 200);
  const stream = response.body!.getReader();
  await stream.read(); // consume initial heartbeat, before revocation
  revokeAgentKey(db, reader.id);
  const blocked = await app.request('/api/snapshot', { headers: { authorization: `Bearer ${reader.key}` } });
  assert.equal(blocked.status, 403);
  const created = await app.request('/api/commands', { method: 'POST', headers: { authorization: `Bearer ${writer.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID(), generation: generation(db), command: 'task.create', payload: { area: 'agency', title: 'Private task written AFTER revocation' } }) });
  assert.equal(created.status, 200);
  const streamed = new TextDecoder().decode((await stream.read()).value);
  assert(streamed.includes('Private task written AFTER revocation'));
  record('revoked-key-keeps-live-sse-access', { freshRequestStatus: blocked.status, mutationStatus: created.status, receivedPostRevocationTitle: streamed.includes('Private task written AFTER revocation') });
  await stream.cancel();
  app.closeStreams();
  db.close();
}

await writeFile(new URL('./03-probe-results.json', import.meta.url), JSON.stringify({ runtime: process.version, results }, null, 2) + '\n');
