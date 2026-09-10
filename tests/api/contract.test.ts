import { describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import {
  generation,
  schemaVersion,
  openDatabase,
  migrate,
} from '../../src/server/db.js';
import {
  createAgent,
  exportWorkspace,
  importWorkspace,
} from '../../src/server/admin.js';
import type { OperationError } from '../../src/shared/model.js';
type Issue = { path: string; message: string };
type Invalid = OperationError & { issues?: Issue[] };
const cyrillic = /[А-Яа-яЁё]/;
const envelope = (f: ReturnType<typeof fixture>, body: unknown) =>
  f.app.request('/api/commands', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
    },
    body: JSON.stringify({
      operationId: 'op',
      generation: generation(f.db),
      ...(body as object),
    }),
  });
describe('TI-046 validation errors carry issues with paths', () => {
  it('a typo in a payload field names payload.title and the unknown key in Russian', async () => {
    const f = fixture();
    const response = await envelope(f, {
      command: 'task.create',
      payload: { area: 'agency', titel: 'x' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Invalid;
    expect(body).toMatchObject({
      ok: false,
      code: 'invalid',
      retryable: false,
    });
    expect(body.message).toMatch(cyrillic);
    expect(body.issues!.map((i) => i.path)).toContain('payload.title');
    expect(body.issues!.some((i) => i.message.includes('titel'))).toBe(true);
    for (const issue of body.issues!) expect(issue.message).toMatch(cyrillic);
    f.close();
  });
  it('query and param errors are prefixed with their target', async () => {
    const f = fixture();
    const query = (await (
      await f.app.request('/api/tasks?limit=abc')
    ).json()) as Invalid;
    expect(query.code).toBe('invalid');
    expect(query.issues![0]!.path).toBe('query.limit');
    const param = await f.app.request('/api/tasks/%20');
    expect(param.status).toBe(400);
    expect(((await param.json()) as Invalid).issues![0]!.path).toMatch(
      /^param\./,
    );
    f.close();
  });
  it('a schema error in the second command of a batch points at commands[1].payload', async () => {
    const f = fixture();
    const response = await f.app.request('/api/commands/batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        operationId: 'batch',
        generation: generation(f.db),
        commands: [
          { command: 'task.create', payload: { area: 'agency', title: 'ok' } },
          { command: 'task.create', payload: { area: 'nowhere', title: 'x' } },
        ],
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Invalid;
    expect(body.issues![0]!.path).toMatch(/^commands\[1\]\.payload/);
    f.close();
  });
});
describe('reads describe the caller and the schema', () => {
  it('/api/me carries generation and seq next to the actor', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'T' },
      }),
    );
    expect(await (await f.app.request('/api/me')).json()).toEqual({
      id: 'owner',
      label: 'Владелец',
      kind: 'owner',
      scope: 'write',
      generation: generation(f.db),
      seq: 1,
    });
    f.close();
  });
  it('/api/snapshot reports the schema version', async () => {
    const f = fixture();
    expect(await (await f.app.request('/api/snapshot')).json()).toMatchObject({
      generation: generation(f.db),
      seq: 0,
      schemaVersion: schemaVersion(),
    });
    f.close();
  });
  it('/api/context lists me, the agents and keeps fields as an inline JSON Schema', async () => {
    const f = fixture();
    createAgent(f.db, { id: 'test-agent', label: 'Тестовый агент' });
    const context = (await (
      await f.app.request('/api/context', {
        headers: { 'x-test-role': 'agent' },
      })
    ).json()) as {
      me: { id: string; kind: string };
      agents: { id: string; label: string; disabledAt: string | null }[];
      fields: Record<string, unknown>;
      commands: { command: string; payload: Record<string, unknown> }[];
    };
    expect(context.me).toMatchObject({ id: 'agent:test-agent', kind: 'agent' });
    expect(context.agents).toEqual([
      {
        id: 'test-agent',
        label: 'Тестовый агент',
        createdAt: expect.any(String),
        disabledAt: null,
      },
    ]);
    expect(context.fields.type).toBe('object');
    expect(context.fields.$ref).toBeUndefined();
    expect(
      (context.fields.properties as Record<string, unknown>).title,
    ).toBeDefined();
    expect(context.commands.map((c) => c.command)).toContain('task.create');
    expect(context.commands[0]!.payload.type).toBe('object');
    f.close();
  });
  it('owner comments after since appear in digest.comments with task titles', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'Задача' },
      }),
    );
    success(
      await f.post(
        {
          command: 'comment.add',
          payload: { taskId: 't', id: 'mine', text: 'Отчёт' },
        },
        { role: 'agent' },
      ),
    );
    success(
      await f.post({
        command: 'comment.add',
        payload: { taskId: 't', id: 'reply', text: 'Ответ владельца' },
      }),
    );
    type Digest = {
      comments: {
        items: {
          id: string;
          taskId: string;
          taskTitle: string;
          text: string;
          seq: number;
          actorId: string;
        }[];
        more: boolean;
        href: string;
      };
    };
    const digest = (await (
      await f.app.request('/api/digest', {
        headers: { 'x-test-role': 'agent' },
      })
    ).json()) as Digest;
    expect(digest.comments.items).toEqual([
      expect.objectContaining({
        id: 'reply',
        taskId: 't',
        taskTitle: 'Задача',
        text: 'Ответ владельца',
        actorId: 'owner',
        seq: 3,
      }),
    ]);
    expect(digest.comments.more).toBe(false);
    const later = (await (
      await f.app.request('/api/digest?since=3', {
        headers: { 'x-test-role': 'agent' },
      })
    ).json()) as Digest;
    expect(later.comments.items).toEqual([]);
    f.close();
  });
});
describe('TI-010 TI-011 reserved identifiers and the origin lookup route', () => {
  it('none, all, by-origin and lookup are refused as new identifiers with the field in issues', async () => {
    const f = fixture();
    for (const id of ['none', 'all']) {
      const response = await envelope(f, {
        command: 'project.create',
        payload: { id, area: 'agency', name: id, color: '#112233' },
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Invalid;
      expect(body.code).toBe('invalid');
      expect(body.issues![0]!.path).toBe('payload.id');
    }
    for (const id of ['by-origin', 'lookup']) {
      const response = await envelope(f, {
        command: 'task.create',
        payload: { id, area: 'agency', title: id },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Invalid).issues![0]!.path).toBe(
        'payload.id',
      );
    }
    expect(f.state().tasks).toEqual([]);
    expect(f.state().projects).toEqual([]);
    f.close();
  });
  it('the origin lookup lives under /api/tasks/lookup/by-origin and does not shadow task ids', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 'from-tg',
          area: 'agency',
          title: 'TG',
          origin: { system: 'tg', ref: '42' },
        },
      }),
    );
    const found = await f.app.request(
      '/api/tasks/lookup/by-origin?system=tg&ref=42',
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: 'from-tg' });
    const missing = await f.app.request(
      '/api/tasks/lookup/by-origin?system=tg&ref=43',
    );
    expect(missing.status).toBe(404);
    const partial = await f.app.request(
      '/api/tasks/lookup/by-origin?system=tg',
    );
    expect(partial.status).toBe(400);
    expect(((await partial.json()) as Invalid).issues![0]!.path).toBe(
      'query.ref',
    );
    const bare = await f.app.request('/api/tasks/lookup');
    expect(bare.status).toBe(404);
    expect(await bare.json()).toMatchObject({ code: 'not_found' });
    // The old flat path is gone: it is now read as a task id and 404s.
    const legacy = await f.app.request('/api/tasks/by-origin?system=tg&ref=42');
    expect(legacy.status).toBe(404);
    expect(await legacy.json()).toMatchObject({ code: 'not_found' });
    f.close();
  });
  it('import refuses reserved identifiers before replaying history', () => {
    const source = fixture();
    const data = exportWorkspace(source.db);
    const target = openDatabase(':memory:');
    migrate(target);
    expect(() =>
      importWorkspace(target, {
        ...data,
        tasks: [
          {
            id: 'none',
            area: 'agency',
            projectId: null,
            title: 'x',
            status: 'todo',
            note: '',
            due: null,
            waitingFor: '',
            followUp: null,
            orderKey: 'a0',
            focus: false,
            focusKey: null,
            focusLeftAt: null,
            archived: false,
            checklist: [],
            commentCount: 0,
            originSystem: null,
            originRef: null,
            originUrl: null,
            originVersion: null,
            createdBy: 'owner',
            createdByLabel: 'Владелец',
            ownerTouchedAt: null,
            ownerFields: [],
            revision: 1,
            createdAt: '2026-09-08T12:00:00.000Z',
            updatedAt: '2026-09-08T12:00:00.000Z',
          },
        ],
      }),
    ).toThrow(/Служебное слово/);
    target.close();
    source.close();
  });
});
describe('TI-040 a name conflict reports the record that was not changed', () => {
  it('project.create with an existing name returns the existing project as current, also from the stored result', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'project.create',
        payload: {
          id: 'p-first',
          area: 'agency',
          name: 'Маркетинг',
          color: '#112233',
        },
      }),
    );
    const dup = await f.post(
      {
        command: 'project.create',
        payload: {
          id: 'p-second',
          area: 'agency',
          name: '  маркетинг ',
          color: '#445566',
        },
      },
      { id: 'dup' },
    );
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({
      code: 'conflict',
      current: { id: 'p-first', name: 'Маркетинг' },
    });
    expect(f.state().projects.map((p) => p.id)).toEqual(['p-first']);
    const stored = (await (
      await f.app.request('/api/operations/dup')
    ).json()) as {
      result: OperationError;
    };
    expect(stored.result.current).toMatchObject({ id: 'p-first' });
    f.close();
  });
  it('renaming a project into a taken name points at the other project', async () => {
    const f = fixture();
    success(
      await f.post({
        command: 'project.create',
        payload: { id: 'p-a', area: 'agency', name: 'Альфа', color: '#112233' },
      }),
    );
    success(
      await f.post({
        command: 'project.create',
        payload: { id: 'p-b', area: 'agency', name: 'Бета', color: '#112233' },
      }),
    );
    const renamed = await f.post({
      command: 'project.update',
      payload: { id: 'p-b', baseRevision: 1, name: 'альфа' },
    });
    expect(renamed.status).toBe(409);
    expect((renamed.body as OperationError).current).toMatchObject({
      id: 'p-a',
    });
    f.close();
  });
});
