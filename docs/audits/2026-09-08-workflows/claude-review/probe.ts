import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fixture, success } from '../../../../tests/api/helpers';
import { openDatabase, migrate } from '../../../../src/server/db';
import {
  createOwner,
  createAgent,
  createAgentKey,
} from '../../../../src/server/admin';
import { createAuth } from '../../../../src/server/auth';
import { createApp } from '../../../../src/server/app';
const facts: Record<string, unknown> = {};
const f = fixture();
try {
  success(
    await f.post({
      command: 'task.create',
      payload: { id: 'owner-task', area: 'agency', title: 'Owner task' },
    }),
  );
  success(
    await f.post(
      {
        command: 'task.move',
        payload: { id: 'owner-task', baseRevision: 1, status: 'done' },
      },
      { id: 'owner-completed' },
    ),
  );
  const undo = await f.post(
    { command: 'undo', payload: { operationId: 'owner-completed' } },
    { role: 'tasks' },
  );
  facts.agentTasksCanUndoOwner = {
    http: undo.status,
    status: f.state().tasks[0]!.status,
  };
  assert.deepEqual(facts.agentTasksCanUndoOwner, { http: 200, status: 'todo' });
  success(
    await f.post(
      {
        command: 'task.move',
        payload: { id: 'owner-task', baseRevision: 3, status: 'done' },
      },
      { id: 'owner-completed-again' },
    ),
  );
  const move = await f.post(
    {
      command: 'task.move',
      payload: { id: 'owner-task', baseRevision: 4, status: 'todo' },
    },
    { role: 'tasks' },
  );
  facts.agentTasksCanDirectlyReopen = {
    http: move.status,
    status: f.state().tasks[0]!.status,
  };
  assert.deepEqual(facts.agentTasksCanDirectlyReopen, {
    http: 200,
    status: 'todo',
  });
  success(
    await f.post({
      command: 'project.create',
      payload: {
        id: 'owner-project',
        area: 'agency',
        name: 'Project',
        color: '#112233',
      },
    }),
  );
  success(
    await f.post(
      {
        command: 'project.update',
        payload: {
          id: 'owner-project',
          baseRevision: 1,
          name: 'Owner renamed',
        },
      },
      { id: 'owner-renamed' },
    ),
  );
  const tasksProjectUndo = await f.post(
    { command: 'undo', payload: { operationId: 'owner-renamed' } },
    { role: 'tasks' },
  );
  const writeProjectUndo = await f.post(
    { command: 'undo', payload: { operationId: 'owner-renamed' } },
    { role: 'agent' },
  );
  facts.projectUndo = {
    tasksHttp: tasksProjectUndo.status,
    writeHttp: writeProjectUndo.status,
    name: f.state().projects[0]!.name,
  };
  assert.deepEqual(facts.projectUndo, {
    tasksHttp: 403,
    writeHttp: 200,
    name: 'Project',
  });
  success(
    await f.post(
      {
        command: 'comment.add',
        payload: {
          taskId: 'owner-task',
          id: 'owner-comment',
          text: 'Owner comment',
        },
      },
      { id: 'owner-comment-add' },
    ),
  );
  const commentUndo = await f.post(
    { command: 'undo', payload: { operationId: 'owner-comment-add' } },
    { role: 'agent' },
  );
  facts.foreignCommentUndo = { http: commentUndo.status };
  assert.equal(commentUndo.status, 403);
  const replay = await f.post(
    {
      command: 'comment.add',
      payload: {
        taskId: 'owner-task',
        id: 'owner-comment',
        text: 'Owner comment',
      },
    },
    { id: 'owner-comment-add', role: 'agent' },
  );
  facts.foreignOperationReplay = { http: replay.status };
  assert.equal(replay.status, 403);
  success(
    await f.post(
      {
        command: 'task.sync',
        payload: {
          origin: { system: 'review', ref: 'source', version: '1' },
          fields: { area: 'agency', title: 'Source', status: 'todo' },
        },
      },
      { role: 'agent' },
    ),
  );
  const sourced = f.state().tasks.find((t) => t.originRef === 'source')!;
  success(
    await f.post({
      command: 'task.move',
      payload: {
        id: sourced.id,
        baseRevision: sourced.revision,
        status: 'done',
      },
    }),
  );
  const sync = success(
    await f.post(
      {
        command: 'task.sync',
        payload: {
          origin: { system: 'review', ref: 'source', version: '2' },
          fields: {
            area: 'agency',
            title: 'Source',
            status: 'todo',
            note: 'New source note',
          },
        },
      },
      { role: 'agent' },
    ),
  );
  facts.sourceSyncPreservesOwner = {
    status: f.state().tasks.find((t) => t.id === sourced.id)!.status,
    skipped: sync.results[0]!.skipped,
  };
  assert.equal(
    (facts.sourceSyncPreservesOwner as { status: string }).status,
    'done',
  );
} finally {
  f.close();
}
const ordering = fixture();
try {
  for (const id of ['a', 'b', 'c'])
    success(
      await ordering.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id },
      }),
    );
  success(
    await ordering.post({
      command: 'task.archive',
      payload: { id: 'b', baseRevision: 1 },
    }),
  );
  const placed = await ordering.post({
    command: 'task.create',
    payload: { id: 'd', area: 'agency', title: 'd', position: { after: 'a' } },
  });
  facts.archivedNeighbor = {
    http: placed.status,
    keys: ordering
      .state()
      .tasks.map((t) => ({ id: t.id, key: t.orderKey, archived: t.archived })),
  };
  assert.equal(placed.status, 200);
  success(
    await ordering.post({
      command: 'task.create',
      payload: { id: 'dest', area: 'personal', title: 'Existing destination' },
    }),
  );
  const moved = await ordering.post({
    command: 'task.update',
    payload: { id: 'a', baseRevision: 1, area: 'personal' },
  });
  facts.areaUpdateReorders = {
    http: moved.status,
    keys: ordering
      .state()
      .tasks.filter((t) => t.area === 'personal')
      .map((t) => ({ id: t.id, key: t.orderKey })),
  };
  assert.equal(moved.status, 200);
  assert.equal(
    new Set(
      ordering
        .state()
        .tasks.filter((t) => t.area === 'personal')
        .map((t) => t.orderKey),
    ).size,
    2,
  );
} finally {
  ordering.close();
}
const db = openDatabase(':memory:');
migrate(db);
const origin = 'http://localhost:4033';
const auth = createAuth(db, {
  baseURL: origin,
  secret: 'isolated-review-fixture-secret-at-least-thirty-two-characters',
});
const app = createApp({ db, auth, baseURL: origin, trustedOrigins: [origin] });
try {
  await createOwner(db, {
    email: 'review@example.test',
    password: 'Isolated-review-fixture-password-2026',
  });
  const login = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-real-ip': '192.0.2.88',
    },
    body: JSON.stringify({
      email: 'review@example.test',
      password: 'Isolated-review-fixture-password-2026',
    }),
  });
  assert.equal(login.status, 200);
  facts.ownerCreationAndLogin = { http: login.status };
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const unbound = await app.request('/api/auth/api-key/create', {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/json',
      'x-real-ip': '192.0.2.88',
    },
    body: JSON.stringify({ name: 'Unbound review key' }),
  });
  const data = await unbound.json();
  assert.equal(unbound.status, 200);
  const use = await app.request('/api/snapshot', {
    headers: { authorization: `Bearer ${data.key}` },
  });
  facts.httpUnboundKey = { createHttp: unbound.status, useHttp: use.status };
  assert.equal(use.status, 403);
  createAgent(db, { id: 'review-agent', label: 'Review agent' });
  const key = await createAgentKey(db, auth, {
    agentId: 'review-agent',
    scope: 'tasks',
  });
  let accepted = 0;
  for (let i = 0; i < 25; i++) {
    const response = await app.request('/api/snapshot', {
      headers: { authorization: `Bearer ${key.key}` },
    });
    assert.equal(response.status, 200);
    accepted++;
  }
  facts.agentKeyRequests = {
    accepted,
    rateLimitEnabled: db.sqlite
      .prepare('select rate_limit_enabled as value from apikey where id = ?')
      .get(key.id),
  };
} finally {
  app.closeStreams();
  db.close();
}
writeFileSync(
  new URL('./probe.json', import.meta.url),
  JSON.stringify(facts, null, 2) + '\n',
);
console.log(JSON.stringify(facts, null, 2));
