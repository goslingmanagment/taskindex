import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { statePaths } from '../../src/cli/state.js';

const actors = {
  'key-a': {
    id: 'agent:a',
    agentId: 'a',
    label: 'A',
    kind: 'agent',
    scope: 'write',
  },
  'key-b': {
    id: 'agent:b',
    agentId: 'b',
    label: 'B',
    kind: 'agent',
    scope: 'read',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BASE = 'https://taskindex.example';

const event = (seq: number) => ({
  seq,
  generation: 'g1',
  at: '2026-09-10T10:00:00.000Z',
  actorId: 'owner',
  actorLabel: 'Владелец',
  operationId: `op${seq}`,
  entityKind: 'task',
  entityId: 't1',
  command: 'task.update',
  changes: {},
  recordRevision: seq,
  firstSeq: seq,
  lastSeq: seq,
});

const operation = (operationSeq: number) => ({
  id: `op${operationSeq}`,
  operationSeq,
  actorId: 'owner',
  actorLabel: 'Владелец',
  at: '2026-09-10T10:00:00.000Z',
  command: 'task.update',
  ok: true,
  firstSeq: null,
  lastSeq: null,
});

type Handler = (url: URL) => Response;

function harness(directory: string, token: keyof typeof actors) {
  const env = {
    TASKINDEX_URL: BASE,
    TASKINDEX_TOKEN: token,
    XDG_STATE_HOME: directory,
  };
  const urls: string[] = [];
  let handler: Handler = () => json({ generation: 'g1' });
  const requestFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/api/me') return json(actors[token]);
    return handler(url);
  }) as typeof fetch;
  return {
    env,
    urls,
    paths: statePaths(env, BASE),
    cursorFile: join(
      statePaths(env, BASE).ops(actors[token].agentId),
      '..',
      'cursor.json',
    ),
    serve(next: Handler) {
      handler = next;
    },
    async run(argv: string[]) {
      const output: Record<string, unknown>[] = [];
      const errors: Record<string, unknown>[] = [];
      urls.length = 0;
      const code = await runCli(argv, {
        env,
        fetch: requestFetch,
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        stderr: (line) =>
          errors.push(JSON.parse(line) as Record<string, unknown>),
        sleep: async () => undefined,
      });
      return { code, output, errors, last: output.at(-1) };
    },
    async cursor() {
      try {
        return JSON.parse(await readFile(this.cursorFile, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        return undefined;
      }
    },
  };
}

describe('saved cursor per server and agent (TI-047)', () => {
  it('cursor show/commit/reset keep {generation, seq, committedAt} and --since last uses them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    const shown = await a.run(['cursor', 'show']);
    expect(shown.code).toBe(0);
    expect(shown.last).toMatchObject({ ok: true, cursor: null });

    const committed = await a.run([
      'cursor',
      'commit',
      '7',
      '--generation',
      'g1',
    ]);
    expect(committed.code).toBe(0);
    expect(committed.last).toMatchObject({
      ok: true,
      cursor: { generation: 'g1', seq: 7 },
    });
    const file = await a.cursor();
    expect(file).toMatchObject({ formatVersion: 1, generation: 'g1', seq: 7 });
    expect(typeof file!.committedAt).toBe('string');
    expect((await stat(a.cursorFile)).mode & 0o777).toBe(0o600);
    expect(a.cursorFile).toBe(join(a.paths.agents, 'a', 'cursor.json'));

    a.serve(() =>
      json({
        generation: 'g1',
        seq: 9,
        today: '2026-09-10',
        timezone: 'Europe/Moscow',
        focus: [],
        waiting: {
          generation: 'g1',
          seq: 9,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
        counts: { tasks: 0, archived: 0, projects: 0 },
        operations: {
          generation: 'g1',
          seq: 9,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
        comments: {
          generation: 'g1',
          seq: 9,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
        operationSeq: 4,
      }),
    );
    const digest = await a.run(['digest', '--since', 'last']);
    expect(digest.code).toBe(0);
    expect(a.urls.filter((url) => url.startsWith('/api/digest'))).toEqual([
      '/api/digest?since=7&generation=g1',
    ]);
    // Reading alone never moves the cursor.
    expect(await a.cursor()).toMatchObject({ seq: 7 });

    const reset = await a.run(['cursor', 'reset']);
    expect(reset.code).toBe(0);
    expect(reset.last).toMatchObject({ ok: true, cursor: null });
    expect(await a.cursor()).toBeUndefined();
  });

  it('without a saved cursor --since last starts at 0 with the server generation; a numeric --since without --generation hints at --since last', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    a.serve((url) =>
      url.pathname === '/api/context'
        ? json({ generation: 'g_srv' })
        : json({
            generation: 'g_srv',
            seq: 3,
            items: [],
            more: false,
            nextCursor: null,
          }),
    );
    const activity = await a.run(['activity', '--since', 'last']);
    expect(activity.code).toBe(0);
    expect(a.urls.filter((url) => url.startsWith('/api/operations'))).toEqual([
      '/api/operations?after=0&generation=g_srv',
    ]);
    const numeric = await a.run(['activity', '--since', '5']);
    expect(numeric.code).toBe(2);
    expect(numeric.last).toMatchObject({ code: 'invalid_arguments' });
    expect(String(numeric.last!.hint)).toContain('--since last');
    const bad = await a.run(['digest', '--since', 'yesterday']);
    expect(bad.code).toBe(2);
  });

  it('--commit writes the cursor only after the last page; an incomplete walk warns and keeps the old position', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    await a.run(['cursor', 'commit', '7', '--generation', 'g1']);
    // events: two pages, the cursor lands on latestSeq of the final page.
    a.serve((url) =>
      url.searchParams.get('since') === '7'
        ? json({
            generation: 'g1',
            latestSeq: 12,
            more: true,
            events: [event(8), event(9)],
          })
        : json({
            generation: 'g1',
            latestSeq: 12,
            more: false,
            events: [event(12)],
          }),
    );
    const events = await a.run([
      'events',
      '--since',
      'last',
      '--all',
      '--commit',
    ]);
    expect(events.code).toBe(0);
    expect(events.output).toHaveLength(2);
    expect(await a.cursor()).toMatchObject({ generation: 'g1', seq: 12 });

    // activity: a page with more: true and no --all does not commit.
    a.serve(() =>
      json({
        generation: 'g1',
        seq: 20,
        items: [],
        more: true,
        nextCursor: 'c1',
      }),
    );
    const partial = await a.run(['activity', '--since', 'last', '--commit']);
    expect(partial.code).toBe(0);
    expect(
      partial.errors.find((line) => line.warning === 'cursor_not_committed'),
    ).toBeDefined();
    expect(await a.cursor()).toMatchObject({ seq: 12 });

    // activity --all: committed after the last page; operationSeq is the
    // position of the last operation of the ascending walk (TI-008).
    a.serve((url) =>
      url.searchParams.has('cursor')
        ? json({
            generation: 'g1',
            seq: 20,
            items: [operation(4), operation(5)],
            more: false,
            nextCursor: null,
          })
        : json({
            generation: 'g1',
            seq: 20,
            items: [operation(3)],
            more: true,
            nextCursor: 'c1',
          }),
    );
    const full = await a.run([
      'activity',
      '--since',
      'last',
      '--all',
      '--commit',
    ]);
    expect(full.code).toBe(0);
    expect(full.output).toHaveLength(2);
    expect(await a.cursor()).toMatchObject({ seq: 20, operationSeq: 5 });

    // digest: operations.more true keeps the position.
    a.serve(() =>
      json({
        generation: 'g1',
        seq: 25,
        today: '2026-09-10',
        timezone: 'Europe/Moscow',
        focus: [],
        waiting: {
          generation: 'g1',
          seq: 25,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
        counts: { tasks: 0, archived: 0, projects: 0 },
        operations: {
          generation: 'g1',
          seq: 25,
          items: [],
          more: true,
          nextCursor: 'x',
          href: '/api/operations?cursor=x',
        },
        comments: {
          generation: 'g1',
          seq: 25,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
        operationSeq: 9,
      }),
    );
    const digest = await a.run(['digest', '--since', 'last', '--commit']);
    expect(digest.code).toBe(0);
    expect(
      digest.errors.find((line) => line.warning === 'cursor_not_committed'),
    ).toBeDefined();
    expect(await a.cursor()).toMatchObject({ seq: 20 });
    // An error page never commits either.
    a.serve(() =>
      json(
        { ok: false, code: 'unavailable', message: 'x', retryable: true },
        503,
      ),
    );
    expect((await a.run(['digest', '--since', 'last', '--commit'])).code).toBe(
      1,
    );
    expect(await a.cursor()).toMatchObject({ seq: 20 });
  });

  it('the operation log has its own position: activity --since last walks after=<operationSeq> and a commit keeps it (TI-008)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    await a.run([
      'cursor',
      'commit',
      '7',
      '--generation',
      'g1',
      '--operation-seq',
      '4',
    ]);
    expect(await a.cursor()).toMatchObject({ seq: 7, operationSeq: 4 });

    // A rejected operation has no events at all: it is only reachable by
    // after=<operationSeq>, never by the event window since=7.
    a.serve(() =>
      json({
        generation: 'g1',
        seq: 7,
        items: [{ ...operation(5), ok: false }],
        more: false,
        nextCursor: null,
      }),
    );
    const activity = await a.run(['activity', '--since', 'last', '--commit']);
    expect(activity.code).toBe(0);
    expect(a.urls.filter((url) => url.startsWith('/api/operations'))).toEqual([
      '/api/operations?after=4&generation=g1',
    ]);
    expect(activity.output.at(-1)).toMatchObject({
      items: [{ id: 'op5', ok: false }],
    });
    expect(await a.cursor()).toMatchObject({ seq: 7, operationSeq: 5 });

    // An explicit --after wins over the cursor.
    await a.run(['activity', '--since', 'last', '--after', '2']);
    expect(a.urls.at(-1)).toBe('/api/operations?after=2&generation=g1');

    // A read of the event feed does not drop the operation position.
    a.serve(() =>
      json({ generation: 'g1', latestSeq: 11, more: false, events: [] }),
    );
    expect((await a.run(['events', '--since', 'last', '--commit'])).code).toBe(
      0,
    );
    expect(await a.cursor()).toMatchObject({ seq: 11, operationSeq: 5 });

    // A bare `cursor commit` keeps it too; --operation-seq replaces it.
    await a.run(['cursor', 'commit', '12', '--generation', 'g1']);
    expect(await a.cursor()).toMatchObject({ seq: 12, operationSeq: 5 });
    await a.run([
      'cursor',
      'commit',
      '13',
      '--generation',
      'g1',
      '--operation-seq',
      '8',
    ]);
    expect(await a.cursor()).toMatchObject({ seq: 13, operationSeq: 8 });
    // A different generation starts both positions from scratch.
    await a.run(['cursor', 'commit', '1', '--generation', 'g2']);
    expect(await a.cursor()).toMatchObject({ generation: 'g2', seq: 1 });
    expect(await a.cursor()).not.toHaveProperty('operationSeq');
  });

  it('digest --since-op windows the operation log by operationSeq', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    a.serve(() =>
      json({
        generation: 'g1',
        seq: 9,
        operationSeq: 6,
        today: '2026-09-10',
        timezone: 'Europe/Moscow',
        focus: [],
        waiting: {
          generation: 'g1',
          seq: 9,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
        counts: { tasks: 0, archived: 0, projects: 0 },
        operations: {
          generation: 'g1',
          seq: 9,
          items: [operation(6)],
          more: false,
          nextCursor: null,
          href: '',
        },
        comments: {
          generation: 'g1',
          seq: 9,
          items: [],
          more: false,
          nextCursor: null,
          href: '',
        },
      }),
    );
    const digest = await a.run(['digest', '--since-op', '4', '--commit']);
    expect(digest.code).toBe(0);
    expect(a.urls.filter((url) => url.startsWith('/api/digest'))).toEqual([
      '/api/digest?sinceOp=4',
    ]);
    expect(await a.cursor()).toMatchObject({ seq: 9, operationSeq: 6 });
    expect((await a.run(['digest', '--since-op', 'x'])).code).toBe(2);
  });

  it('generation_changed is printed with a hint to reset the cursor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    await a.run(['cursor', 'commit', '7', '--generation', 'g_old']);
    a.serve(() =>
      json(
        {
          ok: false,
          code: 'generation_changed',
          message: 'Поколение базы изменилось.',
          retryable: false,
          generation: 'g_new',
        },
        409,
      ),
    );
    const result = await a.run(['digest', '--since', 'last']);
    expect(result.code).toBe(3);
    expect(result.last).toMatchObject({
      code: 'generation_changed',
      generation: 'g_new',
    });
    expect(String(result.last!.hint)).toContain('cursor reset');
    expect(await a.cursor()).toMatchObject({ generation: 'g_old', seq: 7 });
  });

  it('cursors of different agents and servers do not mix; commit without --generation asks the server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-cursor-'));
    const a = harness(directory, 'key-a');
    const b = harness(directory, 'key-b');
    a.serve((url) =>
      url.pathname === '/api/context'
        ? json({ generation: 'g_ctx' })
        : json({}),
    );
    const committed = await a.run(['cursor', 'commit', '3']);
    expect(committed.code).toBe(0);
    expect(await a.cursor()).toMatchObject({ generation: 'g_ctx', seq: 3 });
    expect((await b.run(['cursor', 'show'])).last).toMatchObject({
      cursor: null,
    });
    const other = harness(directory, 'key-a');
    other.env.TASKINDEX_URL = 'https://other.example';
    expect((await other.run(['cursor', 'show'])).last).toMatchObject({
      cursor: null,
    });
    expect((await a.run(['cursor', 'commit', 'x'])).code).toBe(2);
  });
});
