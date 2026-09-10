import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { Outbox, type SavedOperation } from '../../src/cli/outbox.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth.js';
import {
  createAgent,
  createAgentKey,
  createOwner,
} from '../../src/server/admin.js';
import {
  generation,
  latestSeq,
  migrate,
  openDatabase,
  readState,
} from '../../src/server/db.js';
import type {
  OperationError,
  OperationResponse,
  OperationSuccess,
  StoredOperation,
  Task,
} from '../../src/shared/model.js';

it('runs two authenticated agents through owner decisions and recovers a committed CLI operation after losing its response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-agent-cycle-'));
  const db = openDatabase(':memory:');
  migrate(db);
  const baseURL = 'http://localhost:3001';
  const password = 'local-agent-cycle-password-for-tests-only';
  await createOwner(db, { email: 'owner@example.test', password });
  const auth = createAuth(db, {
    baseURL,
    secret: 'local-agent-cycle-secret-for-tests-only-123456789',
  });
  const app = createApp({ db, auth, baseURL, trustedOrigins: [baseURL] });
  try {
    createAgent(db, { id: 'source', label: 'Источник' });
    createAgent(db, { id: 'reviewer', label: 'Проверяющий' });
    const sourceKey = await createAgentKey(db, auth, {
      agentId: 'source',
      scope: 'write',
    });
    const reviewerKey = await createAgentKey(db, auth, {
      agentId: 'reviewer',
      scope: 'tasks',
    });
    let lostId = 'report-with-lost-response';
    const lostRequests: {
      envelope: unknown;
      saved: SavedOperation | undefined;
      status: number;
      result: OperationResponse;
    }[] = [];
    let loseResponse = true;
    const agentCli = (name: string, token: string) => {
      const env = {
        TASKINDEX_URL: baseURL,
        TASKINDEX_TOKEN: token,
        XDG_STATE_HOME: join(directory, name),
      };
      const outbox = new Outbox(env);
      const transport = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const request = new Request(input, init);
        const envelope =
          request.method === 'POST'
            ? ((await request.clone().json()) as { operationId?: string })
            : undefined;
        const saved =
          envelope?.operationId === lostId
            ? await outbox.get(lostId)
            : undefined;
        // Every request executes the real Hono middleware, Better Auth and DB.
        const response = await app.request(request);
        if (envelope?.operationId === lostId) {
          lostRequests.push({
            envelope,
            saved,
            status: response.status,
            result: (await response.clone().json()) as OperationResponse,
          });
          // Lose the response only AFTER the real transaction has committed.
          if (loseResponse) throw new TypeError('Connection lost after commit');
        }
        return response;
      }) as typeof fetch;
      return {
        outbox,
        async run<T>(args: string[]) {
          const output: string[] = [];
          const diagnostics: string[] = [];
          const code = await runCli(args, {
            env,
            fetch: transport,
            stdout: (line) => output.push(line),
            stderr: (line) => diagnostics.push(line),
            sleep: async () => undefined,
          });
          expect(output).toHaveLength(1);
          expect([...output, ...diagnostics].join('\n')).not.toContain(token);
          return { code, body: JSON.parse(output[0]!) as T };
        },
      };
    };
    const source = agentCli('source', sourceKey.key);
    const reviewer = agentCli('reviewer', reviewerKey.key);
    expect((await source.run(['digest'])).code).toBe(0);
    expect(
      (
        await source.run([
          'project',
          'create',
          '--id',
          'source-project',
          '--area',
          'agency',
          '--name',
          'Входящие источника',
          '--color',
          '#123456',
        ])
      ).code,
    ).toBe(0);
    const sync = (version: string, note: string) => [
      'task',
      'sync',
      '--origin',
      JSON.stringify({ system: 'telegram', ref: 'thread-42', version }),
      '--fields',
      JSON.stringify({
        area: 'agency',
        projectId: 'source-project',
        title: 'Проверить отчёт',
        status: 'doing',
        note,
      }),
    ];
    const created = await source.run<OperationSuccess>(
      sync('1', 'Первая версия'),
    );
    expect(created.code).toBe(0);
    const task = created.body.results[0]!.record as Task;
    expect(task.createdBy).toBe('agent:source');

    const login = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ email: 'owner@example.test', password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const ownerChange = await app.request('/api/commands/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseURL, cookie },
      body: JSON.stringify({
        operationId: 'owner-closes-task',
        generation: generation(db),
        commands: [
          {
            command: 'project.create',
            payload: {
              id: 'owner-project',
              area: 'agency',
              name: 'Решения владельца',
              color: '#654321',
            },
          },
          {
            command: 'task.save',
            payload: {
              id: task.id,
              baseRevision: task.revision,
              fields: { projectId: 'owner-project' },
              status: 'done',
            },
          },
        ],
      }),
    });
    expect(ownerChange.status).toBe(200);
    expect(await ownerChange.json()).toMatchObject({
      events: [{ actorId: 'owner' }, { actorId: 'owner' }],
    });

    for (const [cli, version] of [
      [source, '2'],
      [reviewer, '3'],
    ] as const) {
      const updated = await cli.run<OperationSuccess>(
        sync(version, `Версия ${version}`),
      );
      expect(updated.code).toBe(0);
      expect(updated.body.results[0]).toMatchObject({
        record: {
          id: task.id,
          status: 'done',
          projectId: 'owner-project',
          originVersion: version,
        },
        skipped: expect.arrayContaining([
          { field: 'status', reason: 'owner' },
          { field: 'projectId', reason: 'owner' },
        ]),
      });
      expect(updated.body.events[0]?.actorId).toBe(
        `agent:${version === '2' ? 'source' : 'reviewer'}`,
      );
    }
    const stale = await source.run<OperationSuccess>(
      sync('2', 'Старая версия'),
    );
    expect(stale.code).toBe(0);
    expect(stale.body).toMatchObject({
      firstSeq: null,
      events: [],
      results: [{ skipped: 'all', reason: 'stale' }],
    });
    const found = await reviewer.run<Task>([
      'task',
      'find-origin',
      '--system',
      'telegram',
      '--ref',
      'thread-42',
    ]);
    expect(found.code).toBe(0);
    expect(found.body).toMatchObject({
      id: task.id,
      projectId: 'owner-project',
      status: 'done',
    });

    const before = latestSeq(db);
    const report = await reviewer.run<{ status: string; operationId: string }>([
      'comment',
      'add',
      task.id,
      '--text',
      'Проверено, решение владельца сохранено',
      '--operation-id',
      lostId,
    ]);
    expect(report.code).toBe(1);
    expect(report.body).toMatchObject({
      status: 'unknown',
      operationId: lostId,
    });
    expect(lostRequests).toHaveLength(4);
    const committed = lostRequests[0]!.result;
    for (const attempt of lostRequests) {
      expect(attempt.status).toBe(200);
      expect(attempt.saved?.envelope).toEqual(attempt.envelope);
      expect(attempt.envelope).toEqual(lostRequests[0]!.envelope);
      expect(attempt.result).toEqual(committed);
    }
    expect(committed).toMatchObject({
      ok: true,
      operationId: lostId,
      firstSeq: before + 1,
      lastSeq: before + 1,
      events: [{ actorId: 'agent:reviewer', command: 'comment.add' }],
    });
    expect(await reviewer.outbox.get(lostId)).toBeDefined();
    loseResponse = false;
    // Another agent can inspect the result without consuming the sender's outbox.
    const inspected = await source.run<StoredOperation>([
      'operation',
      'get',
      lostId,
    ]);
    expect(inspected.code).toBe(0);
    expect(inspected.body.result).toEqual(committed);
    expect(await reviewer.outbox.get(lostId)).toBeDefined();
    const resumed = await reviewer.run<OperationSuccess>([
      'operation',
      'resume',
      lostId,
    ]);
    expect(resumed.code).toBe(0);
    expect(resumed.body).toEqual(committed);
    expect(await reviewer.outbox.get(lostId)).toBeUndefined();
    expect(lostRequests).toHaveLength(4);
    expect(latestSeq(db)).toBe(before + 1);
    const final = readState(db);
    expect(final.tasks).toHaveLength(1);
    expect(final.tasks[0]).toMatchObject({
      id: task.id,
      status: 'done',
      projectId: 'owner-project',
      revision: found.body.revision,
      commentCount: 1,
    });
    expect(final.comments).toHaveLength(1);
    expect(
      db.sqlite
        .prepare('SELECT count(*) AS n FROM operations WHERE id=?')
        .get(lostId),
    ).toEqual({ n: 1 });
    expect(
      db.sqlite
        .prepare('SELECT count(*) AS n FROM events WHERE operation_id=?')
        .get(lostId),
    ).toEqual({ n: 1 });

    for (const rejection of [
      {
        id: 'conflict-with-lost-response',
        status: 409,
        code: 'conflict',
        exit: 3,
        args: [
          'task',
          'save',
          task.id,
          '--base-revision',
          String(task.revision),
          '--status',
          'doing',
        ],
      },
      {
        id: 'missing-with-lost-response',
        status: 404,
        code: 'not_found',
        exit: 1,
        args: [
          'task',
          'update',
          'missing-task',
          '--base-revision',
          '1',
          '--title',
          'Отчёт',
        ],
      },
    ]) {
      lostId = rejection.id;
      loseResponse = true;
      lostRequests.length = 0;
      const unknown = await reviewer.run<{
        status: string;
        operationId: string;
      }>([...rejection.args, '--operation-id', lostId]);
      expect(unknown.code).toBe(1);
      expect(unknown.body).toMatchObject({
        status: 'unknown',
        operationId: lostId,
      });
      expect(lostRequests).toHaveLength(4);
      const terminal = lostRequests[0]!.result;
      expect(terminal).toMatchObject({
        ok: false,
        operationId: lostId,
        code: rejection.code,
        retryable: false,
      });
      for (const attempt of lostRequests) {
        expect(attempt.status).toBe(rejection.status);
        expect(attempt.saved?.envelope).toEqual(attempt.envelope);
        expect(attempt.envelope).toEqual(lostRequests[0]!.envelope);
        expect(attempt.result).toEqual(terminal);
      }
      expect(await reviewer.outbox.get(lostId)).toBeDefined();
      loseResponse = false;
      // GET succeeds as a read even when this stored operation has ok: false.
      const inspectedError = await source.run<StoredOperation>([
        'operation',
        'get',
        lostId,
      ]);
      expect(inspectedError.code).toBe(0);
      expect(inspectedError.body).toMatchObject({
        ok: false,
        status: rejection.status,
        result: terminal,
      });
      expect(await reviewer.outbox.get(lostId)).toBeDefined();
      const resumedError = await reviewer.run<OperationError>([
        'operation',
        'resume',
        lostId,
      ]);
      expect(resumedError.code).toBe(rejection.exit);
      expect(resumedError.body).toEqual(terminal);
      expect(await reviewer.outbox.get(lostId)).toBeUndefined();
      expect(lostRequests).toHaveLength(4);
      expect(latestSeq(db)).toBe(before + 1);
      expect(readState(db)).toEqual(final);
      expect(
        db.sqlite
          .prepare('SELECT count(*) AS n FROM operations WHERE id=?')
          .get(lostId),
      ).toEqual({ n: 1 });
      expect(
        db.sqlite
          .prepare('SELECT count(*) AS n FROM events WHERE operation_id=?')
          .get(lostId),
      ).toEqual({ n: 0 });
    }
  } finally {
    app.closeStreams();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
