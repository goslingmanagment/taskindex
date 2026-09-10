import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { renderHelp } from '../../src/cli/help.js';
import { Outbox } from '../../src/cli/outbox.js';
import { statePaths } from '../../src/cli/state.js';

const actor = {
  id: 'agent:test',
  agentId: 'test',
  label: 'Тест',
  kind: 'agent',
  scope: 'write',
};

function requestUrl(value: string | URL | Request): URL {
  return new URL(value instanceof Request ? value.url : value.toString());
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== 'string')
    throw new Error('Expected a JSON request body');
  return init.body;
}

// The server confirms a command with the full operation result; the CLI
// settles an envelope only on that shape with the same operationId/generation.
function success(init?: RequestInit, generation = 'g_first') {
  const envelope = JSON.parse(requestBody(init)) as { operationId: string };
  return {
    ok: true,
    operationId: envelope.operationId,
    generation,
    firstSeq: null,
    lastSeq: null,
    results: [{ record: null, changes: {} }],
    events: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function setup(
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
  me: Record<string, unknown> = actor,
) {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-cli-'));
  const env = {
    TASKINDEX_URL: 'https://taskindex.example',
    TASKINDEX_TOKEN: 'secret-test-token',
    XDG_STATE_HOME: directory,
  };
  const output: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const requestFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const target = requestUrl(url);
    // Identity is fetched once per key and cached in the state directory.
    return target.pathname === '/api/me' ? json(me) : handler(target, init);
  }) as typeof fetch;
  return {
    directory,
    env,
    output,
    errors,
    outbox: new Outbox(statePaths(env, env.TASKINDEX_URL).ops('test')),
    run: (argv: string[]) =>
      runCli(argv, {
        env,
        fetch: requestFetch,
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        stderr: (line) => errors.push(line),
        sleep: async () => undefined,
      }),
  };
}

describe('CLI argument errors name the field and the fix', () => {
  it('TI-046: a missing baseRevision is reported in Russian with a path and a hint about task get', async () => {
    let requests = 0;
    const test = await setup(() => {
      requests += 1;
      return json({});
    });
    expect(await test.run(['task', 'move', 't1', '--status', 'doing'])).toBe(2);
    expect(requests).toBe(0);
    const issues = test.output.at(-1)?.issues as {
      path: string;
      message: string;
      hint?: string;
    }[];
    expect(test.output.at(-1)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    expect(issues[0]).toMatchObject({ path: 'baseRevision' });
    expect(issues[0]!.message).toMatch(/[а-я]/);
    expect(issues[0]!.message).not.toMatch(/Invalid input/);
    expect(issues[0]!.hint).toContain('task get');
    expect(issues[0]!.hint).toContain('--base-revision');
    expect(
      await test.run([
        'task',
        'move',
        't1',
        '--base-revision',
        '2',
        '--status',
        'later',
      ]),
    ).toBe(2);
    const status = (
      test.output.at(-1)!.issues as { path: string; hint?: string }[]
    )[0]!;
    expect(status.path).toBe('status');
    expect(status.hint).toBe('Допустимо: todo, doing, waiting, done');
    expect(
      await test.run([
        'task',
        'create',
        '--area',
        'agency',
        '--titel',
        'Опечатка',
      ]),
    ).toBe(2);
    expect(test.output.at(-1)).toMatchObject({
      code: 'invalid_arguments',
      message: 'Флаг --titel не поддерживается командой task create',
      hint: 'taskindex help task create',
    });
    expect(
      await test.run([
        'task',
        'create',
        '--payload',
        '{"area":"agency","titel":"Опечатка","checklist":[{"id":"s1","text":"","done":false}]}',
      ]),
    ).toBe(2);
    const paths = (test.output.at(-1)!.issues as { path: string }[]).map(
      (issue) => issue.path,
    );
    expect(paths).toContain('title');
    expect(paths).toContain('checklist[0].text');
    expect(paths.some((path) => path === '' || path === 'payload')).toBe(true);
  });

  it('TI-046: issues sent by the server are printed as they are, with a hint when the field is known', async () => {
    const test = await setup(() =>
      json(
        {
          ok: false,
          code: 'invalid',
          message: 'Проверьте поля запроса.',
          retryable: false,
          issues: [
            { path: 'payload.origin.version', message: 'Неверный ввод' },
            { path: 'payload.custom', message: 'Лишнее поле' },
          ],
        },
        400,
      ),
    );
    expect(
      await test.run([
        'task',
        'sync',
        '--origin',
        '{"system":"telegram","ref":"1","version":"x"}',
        '--fields',
        '{"area":"agency","title":"Т"}',
        '--generation',
        'g_first',
      ]),
    ).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      ok: false,
      code: 'invalid',
      issues: [
        {
          path: 'payload.origin.version',
          message: 'Неверный ввод',
          hint: 'Упорядоченная версия самого источника, не время наблюдения',
        },
        { path: 'payload.custom', message: 'Лишнее поле' },
      ],
    });
  });
});

describe('owner decisions in the CLI (TI-027)', () => {
  it('--confirm-owner-fields goes into the envelope; a 403 without it explains the flag', async () => {
    const sent: Record<string, unknown>[] = [];
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
      sent.push(body);
      if (body.confirmOwnerFields !== true)
        return json(
          {
            ok: false,
            code: 'forbidden',
            message:
              'Поле защищено владельцем: подтвердите поручение флагом confirmOwnerFields: true.',
            retryable: false,
            conflicts: [
              { entityKind: 'task', entityId: 't1', fields: ['title'] },
            ],
          },
          403,
        );
      return json(success(init));
    });
    const update = (id: string, ...extra: string[]) => [
      'task',
      'update',
      't1',
      '--base-revision',
      '3',
      '--title',
      'Новое название',
      '--operation-id',
      id,
      ...extra,
    ];
    expect(await test.run(update('own1'))).toBe(4);
    expect(test.output.at(-1)).toMatchObject({
      code: 'forbidden',
      conflicts: [{ fields: ['title'] }],
    });
    expect(String(test.output.at(-1)!.hint)).toContain(
      '--confirm-owner-fields',
    );
    expect(sent[0]).not.toHaveProperty('confirmOwnerFields');
    // A definitive rejection: the envelope is gone, the retry is a new decision.
    expect(await test.outbox.get('own1')).toBeUndefined();

    expect(await test.run(update('own2', '--confirm-owner-fields'))).toBe(0);
    expect(sent.at(-1)).toMatchObject({
      operationId: 'own2',
      confirmOwnerFields: true,
      command: 'task.update',
    });
    expect(sent.at(-1)!.payload).not.toHaveProperty('confirmOwnerFields');

    const batch = await runCli(
      ['batch', '--file', '-', '--confirm-owner-fields'],
      {
        env: test.env,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          const u = requestUrl(url);
          if (u.pathname === '/api/me') return json(actor);
          if (u.pathname === '/api/context')
            return json({ generation: 'g_first' });
          sent.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
          return json(success(init));
        }) as typeof fetch,
        readInput: async () =>
          JSON.stringify([
            {
              command: 'task.archive',
              payload: { id: 't1', baseRevision: 3 },
            },
          ]),
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );
    expect(batch).toBe(0);
    expect(sent.at(-1)).toMatchObject({ confirmOwnerFields: true });
    expect(sent.at(-1)).toHaveProperty('commands');
    expect(JSON.stringify(renderHelp('task', 'update'))).toContain(
      '--confirm-owner-fields',
    );
  });

  it('task focus is not a command any more; a 403 on focus explains who sets it', async () => {
    const test = await setup((url) =>
      url.pathname === '/api/context'
        ? json({ generation: 'g_first' })
        : json(
            {
              ok: false,
              code: 'forbidden',
              message: 'Поле focus меняет только владелец.',
              retryable: false,
            },
            403,
          ),
    );
    expect(await test.run(['task', 'focus', 't1'])).toBe(2);
    expect(test.output.at(-1)).toMatchObject({
      code: 'invalid_arguments',
      hint: 'taskindex help task',
    });
    expect(String(test.output.at(-1)!.message)).toContain('focus');
    expect(
      await test.run([
        'task',
        'update',
        't1',
        '--base-revision',
        '3',
        '--focus',
        'true',
      ]),
    ).toBe(4);
    expect(String(test.output.at(-1)!.hint)).toContain('владелец');
  });
});

describe('CLI durable operations', () => {
  it('requires the saved generation with a nonzero event cursor', async () => {
    let requests = 0;
    const test = await setup(() => {
      requests += 1;
      return json({ generation: 'g_new', events: [], more: false });
    });
    expect(await test.run(['events', '--since', '42'])).toBe(2);
    expect(requests).toBe(0);
    expect(
      await test.run(['events', '--since', '42', '--generation', 'g_old']),
    ).toBe(0);
  });

  it('retains the operation id when status lookup also loses its connection', async () => {
    const test = await setup((url) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      throw new TypeError('network down');
    });
    await test.run([
      'comment',
      'add',
      't1',
      '--text',
      'Отчёт',
      '--operation-id',
      'lost-status',
    ]);
    expect(await test.run(['operation', 'get', 'lost-status'])).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      operationId: 'lost-status',
      status: 'unknown',
    });
    expect(await test.run(['operation', 'resume', 'lost-status'])).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      operationId: 'lost-status',
      status: 'unknown',
    });
    expect(await test.outbox.get('lost-status')).toBeDefined();
  });

  it('persists before POST, retries the identical envelope and removes only after confirmation', async () => {
    const bodies: string[] = [];
    const test = await setup(async (url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      const body = requestBody(init);
      bodies.push(body);
      const saved = JSON.parse(
        await readFile(join(test.outbox.directory, 'op1.json'), 'utf8'),
      );
      expect(saved.envelope).toEqual(JSON.parse(body));
      expect(saved.actorId).toBe('agent:test');
      expect(JSON.stringify(saved)).not.toContain('secret-test-token');
      expect(
        (await stat(join(test.outbox.directory, 'op1.json'))).mode & 0o777,
      ).toBe(0o600);
      if (bodies.length === 1)
        throw new TypeError('connection reset after commit');
      return json(success(init));
    });
    expect(
      await test.run([
        'task',
        'create',
        '--area',
        'agency',
        '--title',
        'Проверить',
        '--operation-id',
        'op1',
      ]),
    ).toBe(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await test.outbox.get('op1')).toBeUndefined();
    expect(test.output.at(-1)?.ok).toBe(true);
  });

  it('keeps a held operation after all retryable 503 responses, then resumes after open-writes', async () => {
    let held = true;
    const bodies: unknown[] = [];
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      if (url.pathname.startsWith('/api/operations/'))
        return json({ ok: false, code: 'not_found', retryable: false }, 404);
      bodies.push(JSON.parse(requestBody(init)));
      return held
        ? json(
            {
              ok: false,
              code: 'unavailable',
              message: 'Запись закрыта',
              retryable: true,
            },
            503,
          )
        : json(success(init));
    });
    expect(
      await test.run([
        'task',
        'archive',
        't1',
        '--base-revision',
        '3',
        '--operation-id',
        'op2',
      ]),
    ).toBe(1);
    expect(bodies).toHaveLength(4);
    expect(test.output.at(-1)).toMatchObject({
      code: 'unavailable',
      operationId: 'op2',
      retryable: true,
    });
    expect(await test.outbox.get('op2')).toBeDefined();
    held = false;
    expect(await test.run(['operation', 'resume', 'op2'])).toBe(0);
    expect(bodies.at(-1)).toEqual(bodies[0]);
    expect(await test.outbox.get('op2')).toBeUndefined();
  });

  it('reports unknown network outcome and resolves a previously committed result without another POST', async () => {
    let resolve = false;
    let posts = 0;
    const test = await setup((url) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      if (resolve)
        return json({
          id: 'op3',
          status: 200,
          ok: true,
          actorId: 'agent:test',
          actorLabel: 'Тест',
          command: 'comment.add',
          createdAt: '2026-09-10T10:00:00.000Z',
          taskCount: 1,
          titles: [],
          firstSeq: 1,
          lastSeq: 1,
          result: {
            ok: true,
            operationId: 'op3',
            generation: 'g_first',
            firstSeq: 1,
            lastSeq: 1,
            results: [{ record: null, changes: {} }],
            events: [],
          },
        });
      posts += 1;
      throw new TypeError('disconnected');
    });
    expect(
      await test.run([
        'comment',
        'add',
        't1',
        '--text',
        'Отчёт',
        '--operation-id',
        'op3',
      ]),
    ).toBe(1);
    expect(test.output.at(-1)).toMatchObject({
      status: 'unknown',
      operationId: 'op3',
    });
    expect(await test.outbox.get('op3')).toBeDefined();
    resolve = true;
    expect(await test.run(['operation', 'resume', 'op3'])).toBe(0);
    expect(posts).toBe(4);
    expect(await test.outbox.get('op3')).toBeUndefined();
  });

  it('does not silently change a saved generation or overwrite an existing operation', async () => {
    const sent: Record<string, unknown>[] = [];
    let generation = 'g_old';
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context') return json({ generation });
      if (url.pathname.startsWith('/api/operations/'))
        return json({ ok: false, code: 'not_found', retryable: false }, 404);
      const body = JSON.parse(requestBody(init)) as Record<string, unknown>;
      sent.push(body);
      if (generation === 'g_old') throw new TypeError('network');
      return json(
        {
          ok: false,
          code: 'generation_changed',
          message: 'База восстановлена',
          retryable: false,
        },
        409,
      );
    });
    await test.run([
      'task',
      'create',
      '--area',
      'agency',
      '--title',
      'Исходная',
      '--operation-id',
      'op4',
    ]);
    expect(
      await test.run([
        'task',
        'create',
        '--area',
        'agency',
        '--title',
        'Подмена',
        '--operation-id',
        'op4',
      ]),
    ).toBe(2);
    expect(sent).toHaveLength(4);
    generation = 'g_new';
    expect(await test.run(['operation', 'resume', 'op4'])).toBe(3);
    expect(sent.at(-1)?.generation).toBe('g_old');
    expect(await test.outbox.get('op4')).toBeUndefined();
  });

  it('returns current on conflict, removes the terminal envelope and maps authorization exit codes', async () => {
    let status = 409;
    const test = await setup((url) =>
      url.pathname === '/api/context'
        ? json({ generation: 'g_first' })
        : json(
            {
              ok: false,
              code: status === 409 ? 'conflict' : 'forbidden',
              message: 'Отказ',
              retryable: false,
              current: { revision: 8 },
            },
            status,
          ),
    );
    expect(
      await test.run([
        'task',
        'update',
        't1',
        '--base-revision',
        '1',
        '--title',
        'Правка',
        '--operation-id',
        'op5',
      ]),
    ).toBe(3);
    expect(test.output.at(-1)?.current).toEqual({ revision: 8 });
    expect(await test.outbox.get('op5')).toBeUndefined();
    status = 403;
    expect(
      await test.run(['task', 'archive', 't1', '--base-revision', '8']),
    ).toBe(4);
  });

  it('supports atomic batch files and does not reinterpret the command payload', async () => {
    let sent: Record<string, unknown> | undefined;
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      expect(url.pathname).toBe('/api/commands/batch');
      sent = JSON.parse(requestBody(init));
      return json(success(init));
    });
    const commands = [
      {
        command: 'task.sync',
        payload: {
          origin: { system: 'telegram', ref: '42' },
          fields: { area: 'agency', title: 'Источник без версии' },
        },
      },
    ];
    const code = await runCli(['batch', '--file', '-', '--dry-run'], {
      env: test.env,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = requestUrl(url);
        if (u.pathname === '/api/me') return json(actor);
        if (u.pathname === '/api/context')
          return json({ generation: 'g_first' });
        sent = JSON.parse(requestBody(init));
        return json(success(init));
      }) as typeof fetch,
      readInput: async () => JSON.stringify(commands),
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(sent).toMatchObject({
      commands,
      dryRun: true,
      generation: 'g_first',
    });
    expect(await readdir(test.outbox.directory)).toEqual([]);
  });

  it('follows every tasks page explicitly and carries the generation with its cursor', async () => {
    const urls: URL[] = [];
    const test = await setup((url) => {
      urls.push(url);
      return url.searchParams.has('cursor')
        ? json({
            generation: 'g_first',
            items: [{ id: 'b' }],
            more: false,
            nextCursor: null,
          })
        : json({
            generation: 'g_first',
            items: [{ id: 'a' }],
            more: true,
            nextCursor: 'opaque',
          });
    });
    expect(await test.run(['tasks', '--all', '--limit', '1'])).toBe(0);
    expect(test.output).toHaveLength(2);
    expect(urls[1]?.searchParams.get('cursor')).toBe('opaque');
    expect(urls[1]?.searchParams.get('generation')).toBe('g_first');
  });
});

// TI-037, plan 01 step 8(a): the light request before a write is `GET /api/me`
// — it carries `generation` and `seq`, so no separate /api/generation route was
// added and the heavy /api/context is only the fallback for an older server.
describe('поколение конверта берётся из лёгкого запроса (TI-037)', () => {
  it('запись без --generation спрашивает /api/me, а /api/context не трогает', async () => {
    const seen: string[] = [];
    const test = await setup(
      (url, init) => {
        seen.push(url.pathname);
        return json(success(init, 'g_me'));
      },
      { ...actor, generation: 'g_me', seq: 12 },
    );
    expect(
      await test.run(['task', 'create', '--area', 'agency', '--title', 'Т']),
    ).toBe(0);
    expect(seen).toEqual(['/api/commands']);
    expect(test.output.at(-1)).toMatchObject({ ok: true, generation: 'g_me' });
  });

  it('сервер без generation в /api/me: CLI дочитывает /api/context', async () => {
    const seen: string[] = [];
    const test = await setup((url, init) => {
      seen.push(url.pathname);
      return url.pathname === '/api/context'
        ? json({ generation: 'g_first' })
        : json(success(init));
    });
    expect(
      await test.run(['task', 'create', '--area', 'agency', '--title', 'Т']),
    ).toBe(0);
    expect(seen).toEqual(['/api/context', '/api/commands']);
  });
});

// TI-026: the appearance preference is a workspace record like any other, but
// only the owner writes it and its id is fixed, so `appearance set` can read
// its own baseRevision.
describe('оформление владельца в CLI (TI-026)', () => {
  const appearance = (revision: number) => ({
    id: 'owner',
    mode: 'system',
    skinId: 'classic',
    revision,
    updatedAt: null,
  });

  it('appearance get печатает запись, appearance set без --base-revision берёт revision оттуда', async () => {
    const seen: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const test = await setup((url, init) => {
      seen.push(url.pathname);
      if (url.pathname === '/api/appearance') return json(appearance(4));
      if (url.pathname === '/api/context')
        return json({ generation: 'g_first' });
      sent.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
      return json(success(init));
    });
    expect(await test.run(['appearance', 'get'])).toBe(0);
    expect(test.output.at(-1)).toMatchObject({
      mode: 'system',
      skinId: 'classic',
      revision: 4,
    });
    expect(
      await test.run([
        'appearance',
        'set',
        '--mode',
        'dark',
        '--skin-id',
        'focus',
      ]),
    ).toBe(0);
    expect(sent.at(-1)).toMatchObject({
      command: 'appearance.update',
      payload: { baseRevision: 4, mode: 'dark', skinId: 'focus' },
    });
    // The explicit flag still wins and costs no extra read.
    const before = seen.filter((path) => path === '/api/appearance').length;
    expect(
      await test.run([
        'appearance',
        'set',
        '--base-revision',
        '9',
        '--mode',
        'light',
      ]),
    ).toBe(0);
    expect(sent.at(-1)).toMatchObject({
      payload: { baseRevision: 9, mode: 'light' },
    });
    expect(seen.filter((path) => path === '/api/appearance')).toHaveLength(
      before,
    );
  });

  it('appearance set без полей — ошибка аргументов; агенту 403 объясняет, кто меняет оформление', async () => {
    const test = await setup((url) =>
      url.pathname === '/api/appearance'
        ? json(appearance(1))
        : url.pathname === '/api/context'
          ? json({ generation: 'g_first' })
          : json(
              {
                ok: false,
                code: 'forbidden',
                message: 'Оформление меняет только владелец.',
                retryable: false,
              },
              403,
            ),
    );
    expect(await test.run(['appearance', 'set'])).toBe(2);
    expect(test.output.at(-1)).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      hint: 'taskindex help appearance set',
    });
    expect(await test.run(['appearance', 'set', '--mode', 'dark'])).toBe(4);
    expect(String(test.output.at(-1)!.hint)).toContain(
      'оформление меняет только владелец',
    );
    // Help shows the three flags and does not demand --base-revision.
    const help = JSON.parse(
      JSON.stringify(renderHelp('appearance', 'set')),
    ) as {
      usage: string;
      flags: { flag: string; required?: boolean }[];
    };
    for (const flag of ['--base-revision', '--mode', '--skin-id'])
      expect(
        help.flags.some((entry) => entry.flag === flag),
        flag,
      ).toBe(true);
    expect(
      help.flags.find((entry) => entry.flag === '--base-revision')?.required,
    ).toBeUndefined();
    expect(help.usage).toContain('[--base-revision N]');
  });
});

// TI-078, plan 13 step 7: the desk is a read. The CLI prints what /api/focus
// answers, so a new field of the desk reaches an agent without a CLI release;
// setting the focus stays with the owner, `task focus` is not a command.
describe('стол Focus в CLI (TI-078)', () => {
  const desk = {
    generation: 'g_first',
    seq: 42,
    current: { id: 't1', title: 'Текущая', focusKey: 'a0' },
    next: [
      { id: 't2', title: 'Следующая', focusKey: 'a1' },
      { id: 't3', title: 'Третья', focusKey: 'a2' },
    ],
    waiting: [{ id: 't4', title: 'Ждём ответа', followUp: '2026-09-11' }],
    recent: [{ id: 't5', title: 'Ушла со стола', focusLeftAt: '2026-09-09' }],
    counts: { focus: 3, parked: 7, waiting: 1 },
    groups: [{ id: 'selected', items: [], more: false, nextCursor: null }],
  };

  it('focus печатает стол целиком, как его отдаёт /api/focus', async () => {
    const test = await setup((url) =>
      url.pathname === '/api/focus'
        ? json(desk)
        : json({ ok: false, code: 'not_found' }, 404),
    );
    expect(await test.run(['focus'])).toBe(0);
    expect(test.output.at(-1)).toEqual(desk);
    // Setting the focus is not a CLI command: the group lists only the read.
    expect(await test.run(['task', 'focus', 't1'])).toBe(2);
    expect(test.output.at(-1)).toMatchObject({
      code: 'invalid_arguments',
      hint: 'taskindex help task',
    });
  });

  it('digest несёт current и next того же стола', async () => {
    const test = await setup((url) =>
      url.pathname === '/api/digest'
        ? json({
            generation: 'g_first',
            seq: 42,
            operationSeq: 7,
            current: desk.current,
            next: desk.next,
            counts: desk.counts,
          })
        : json({ ok: false, code: 'not_found' }, 404),
    );
    expect(await test.run(['digest'])).toBe(0);
    expect(test.output.at(-1)).toMatchObject({
      current: { id: 't1' },
      next: [{ id: 't2' }, { id: 't3' }],
      counts: { focus: 3 },
    });
  });
});
