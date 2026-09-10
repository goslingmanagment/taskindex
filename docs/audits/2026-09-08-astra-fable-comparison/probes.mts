import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  generation,
  readState,
} from '../../../src/server/db.ts';
import { createAuth } from '../../../src/server/auth.ts';
import {
  createOwner,
  createAgent,
  createAgentKey,
} from '../../../src/server/admin.ts';
import { createApp } from '../../../src/server/app.ts';
import { Outbox } from '../../../src/cli/outbox.ts';
import { runCli } from '../../../src/cli/run.ts';
import { fixture } from '../../../tests/api/helpers.ts';

const results: Record<string, unknown> = {
  node: process.version,
  at: new Date().toISOString(),
};
const dir = await mkdtemp(join(tmpdir(), 'taskindex-comparison-'));
const database = join(dir, 'probe.db');
const db = openDatabase(database);
migrate(db);
const baseURL = 'http://localhost:3001';
const password = 'comparison-local-owner-password-only-2026';
await createOwner(db, { email: 'owner@example.test', password });
const auth = createAuth(db, {
  baseURL,
  secret: 'comparison-local-auth-secret-only-12345678901234567890',
});
createAgent(db, { id: 'agent-a', label: 'Agent A' });
createAgent(db, { id: 'agent-b', label: 'Agent B' });
const a = await createAgentKey(db, auth, {
  agentId: 'agent-a',
  scope: 'tasks',
});
const b = await createAgentKey(db, auth, {
  agentId: 'agent-b',
  scope: 'tasks',
});
const app = createApp({ db, auth, baseURL, trustedOrigins: [baseURL] });
const statePath = join(dir, 'shared-state');
const envFor = (token: string, path = statePath) => ({
  TASKINDEX_URL: baseURL,
  TASKINDEX_TOKEN: token,
  XDG_STATE_HOME: path,
});
const transport = (async (input: RequestInfo | URL, init?: RequestInit) =>
  app.request(new Request(input, init))) as typeof fetch;
const cli = async (args: string[], token: string, path = statePath) => {
  const stdout: string[] = [],
    stderr: string[] = [];
  const code = await runCli(args, {
    env: envFor(token, path),
    fetch: transport,
    sleep: async () => {},
    stdout: (x) => stdout.push(x),
    stderr: (x) => stderr.push(x),
  });
  return {
    code,
    stdout: stdout.map((x) => JSON.parse(x)),
    stderr: stderr.map((x) => JSON.parse(x)),
  };
};
try {
  const saved = new Outbox(envFor(a.key));
  await saved.put({
    formatVersion: 1,
    baseUrl: baseURL,
    endpoint: '/api/commands',
    envelope: {
      generation: generation(db),
      operationId: 'saved-by-agent-a-not-sent',
      command: 'task.create',
      payload: {
        id: 'task-from-a-envelope',
        area: 'agency',
        title: 'Intended by A, not sent yet',
      },
    },
  });
  const resumed = await cli(['operation', 'resume'], b.key);
  results.sharedOutbox = {
    resumedByBExit: resumed.code,
    taskCreatedBy: readState(db).tasks.find(
      (t) => t.id === 'task-from-a-envelope',
    )?.createdBy,
    bSawPendingA: JSON.stringify(resumed.stderr).includes(
      'saved-by-agent-a-not-sent',
    ),
    envelopeRemoved: !(await saved.get('saved-by-agent-a-not-sent')),
  };

  const acceptedA = {
    generation: generation(db),
    operationId: 'already-committed-by-a',
    command: 'task.create',
    payload: {
      id: 'committed-a-task',
      area: 'agency',
      title: 'Already committed by A',
    },
  };
  await app.request('/api/commands', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${a.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(acceptedA),
  });
  await saved.put({
    formatVersion: 1,
    baseUrl: baseURL,
    endpoint: '/api/commands',
    envelope: acceptedA,
  });
  const committedResume = await cli(['operation', 'resume'], b.key);
  results.alreadyCommittedControl = {
    bResumeExit: committedResume.code,
    originalActorPreserved:
      readState(db).tasks.find((t) => t.id === 'committed-a-task')
        ?.createdBy === 'agent:agent-a',
  };

  const filters = await cli(
    ['tasks', '--today', 'true'],
    a.key,
    join(dir, 'clean-state'),
  );
  const me = await cli(['me'], a.key, join(dir, 'clean-state'));
  results.cliErgonomics = { today: filters, me };
  await mkdir(saved.directory, { recursive: true });
  await writeFile(join(saved.directory, 'bad name.json'), '{}');
  const broken = await cli(['context'], a.key);
  results.corruptOutboxBlocksRead = {
    exit: broken.code,
    output: broken.stdout,
  };

  db.sqlite.exec(
    'CREATE TEMP TABLE probe_updates(last_changed INTEGER, updated_changed INTEGER); CREATE TEMP TRIGGER probe_apikey_update AFTER UPDATE ON main.apikey BEGIN INSERT INTO probe_updates VALUES(OLD.last_request IS NOT NEW.last_request, OLD.updated_at IS NOT NEW.updated_at); END;',
  );
  const held = createApp({
    db,
    auth,
    baseURL,
    trustedOrigins: [baseURL],
    writes: 'held',
    deploymentId: 'comparison-held',
  });
  try {
    // Warm plugin cleanup before isolating one read. No production credentials or DB.
    await held.request('/api/snapshot', {
      headers: { authorization: `Bearer ${a.key}` },
    });
    db.sqlite.prepare('DELETE FROM probe_updates').run();
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeSeq = db.sqlite
      .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events')
      .get();
    const response = await held.request('/api/snapshot', {
      headers: { authorization: `Bearer ${a.key}` },
    });
    const updates = db.sqlite.prepare('SELECT * FROM probe_updates').all();
    const wal = await stat(database + '-wal').catch(() => ({ size: 0 }));
    results.agentReadWrites = {
      status: response.status,
      updates,
      walBytes: wal.size,
      beforeSeq,
      afterSeq: db.sqlite
        .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events')
        .get(),
      writes: ((await (await held.request('/health')).json()) as any).writes,
    };
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const health = await held.request('/health');
    const healthWal = await stat(database + '-wal').catch(() => ({ size: 0 }));
    results.healthNoop = { status: health.status, walBytes: healthWal.size };
  } finally {
    held.closeStreams();
  }

  const unauth = await app.request('/api/auth/api-key/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ name: 'http-test' }),
  });
  const login = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  const httpCreated = await app.request('/api/auth/api-key/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL, cookie },
    body: JSON.stringify({ name: 'http-test' }),
  });
  const keyBody = (await httpCreated.json()) as any;
  let businessStatus: number | null = null;
  if (keyBody.key)
    businessStatus = (
      await app.request('/api/snapshot', {
        headers: { authorization: `Bearer ${keyBody.key}` },
      })
    ).status;
  results.apiKeyHttpSurface = {
    unauthenticatedCreate: unauth.status,
    authenticatedOwnerCreate: httpCreated.status,
    resultingUnboundKeyBusinessAccess: businessStatus,
  };
} finally {
  app.closeStreams();
  db.close();
}

const f = fixture();
try {
  await f.post({
    command: 'task.create',
    payload: { id: 'pagination-a', area: 'agency', title: 'One' },
  });
  await f.post({
    command: 'task.create',
    payload: { id: 'pagination-b', area: 'agency', title: 'Two' },
  });
  const first = (await (
    await f.app.request('/api/tasks?limit=1')
  ).json()) as any;
  await f.post({
    command: 'task.create',
    payload: { id: 'pagination-c', area: 'personal', title: 'Unrelated write' },
  });
  const next = await f.app.request(
    '/api/tasks?limit=1&cursor=' + encodeURIComponent(first.nextCursor),
  );
  results.paginationAfterWrite = {
    firstMore: first.more,
    secondStatus: next.status,
    response: await next.json(),
  };
  await f.post({
    command: 'project.create',
    payload: {
      id: 'existing-project',
      area: 'agency',
      name: 'Маркетинг',
      color: '#112233',
    },
  });
  const duplicate = await f.post({
    command: 'project.create',
    payload: {
      id: 'rejected-project',
      area: 'agency',
      name: ' маркетинг ',
      color: '#334455',
    },
  });
  results.duplicateProjectCurrent = {
    status: duplicate.status,
    currentId: (duplicate.body as any).current?.id,
    existingIds: f.state().projects.map((p) => p.id),
  };
} finally {
  f.close();
}
console.log(JSON.stringify(results, null, 2));
