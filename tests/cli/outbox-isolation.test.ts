import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';

const BASE_URL = 'https://taskindex.example';
const actors: Record<string, Record<string, unknown>> = {
  'Bearer key-a': {
    id: 'agent:a',
    agentId: 'a',
    label: 'Агент A',
    kind: 'agent',
    scope: 'write',
  },
  // A rotated key of the same agent: a different token, the same identity.
  'Bearer key-a-rotated': {
    id: 'agent:a',
    agentId: 'a',
    label: 'Агент A',
    kind: 'agent',
    scope: 'write',
  },
  'Bearer key-b': {
    id: 'agent:b',
    agentId: 'b',
    label: 'Агент B',
    kind: 'agent',
    scope: 'write',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Post {
  token: string;
  operationId: string;
}

function agent(directory: string, token: string, posts: Post[]) {
  let network = true;
  const env = {
    TASKINDEX_URL: BASE_URL,
    TASKINDEX_TOKEN: token,
    XDG_STATE_HOME: directory,
  };
  const requestFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get('authorization') ?? '';
    if (url.pathname === '/api/me') {
      const actor = actors[authorization];
      return actor
        ? json(actor)
        : json({ ok: false, code: 'unauthorized', retryable: false }, 401);
    }
    if (url.pathname === '/api/context') return json({ generation: 'g1' });
    if (url.pathname === '/api/tasks')
      return json({
        generation: 'g1',
        seq: 0,
        items: [],
        more: false,
        nextCursor: null,
      });
    if (url.pathname.startsWith('/api/operations/'))
      return json({ ok: false, code: 'not_found', retryable: false }, 404);
    if (request.method === 'POST') {
      if (!network) throw new TypeError('network down');
      const envelope = (await request.json()) as { operationId: string };
      posts.push({ token: authorization, operationId: envelope.operationId });
      return json({
        ok: true,
        operationId: envelope.operationId,
        generation: 'g1',
        firstSeq: 1,
        lastSeq: 1,
        results: [{ record: null, changes: {} }],
        events: [],
      });
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  return {
    env,
    offline() {
      network = false;
    },
    online() {
      network = true;
    },
    async run(argv: string[]) {
      const output: Record<string, unknown>[] = [];
      const errors: string[] = [];
      const code = await runCli(argv, {
        env,
        fetch: requestFetch,
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        stderr: (line) => errors.push(line),
        sleep: async () => undefined,
      });
      return { code, output, errors, last: output.at(-1) };
    },
  };
}

async function filesNamed(root: string, name: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe('outbox isolation between agents sharing one state directory', () => {
  it('TI-035: another agent neither lists nor resends a pending envelope, and the owner resends it after key rotation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-outbox-'));
    const posts: Post[] = [];
    const a = agent(directory, 'key-a', posts);
    a.offline();
    const held = await a.run([
      'comment',
      'add',
      't1',
      '--text',
      'Отчёт агента A',
      '--operation-id',
      'a-op-1',
    ]);
    expect(held.code).toBe(1);
    expect(held.last).toMatchObject({
      status: 'unknown',
      operationId: 'a-op-1',
    });
    expect(posts).toEqual([]);
    expect(await filesNamed(directory, 'a-op-1.json')).toHaveLength(1);

    const b = agent(directory, 'key-b', posts);
    const read = await b.run(['tasks']);
    expect(read.code).toBe(0);
    expect(read.errors.join('\n')).not.toContain('a-op-1');

    const resumedAll = await b.run(['operation', 'resume']);
    expect(posts).toEqual([]);
    expect(resumedAll.code).toBe(0);
    expect(resumedAll.last).toEqual({ ok: true, resumed: 0 });

    const resumedForeign = await b.run(['operation', 'resume', 'a-op-1']);
    expect(resumedForeign.code).toBe(2);
    expect(resumedForeign.last).toMatchObject({
      code: 'invalid_arguments',
      message: 'Сохранённый конверт не найден',
    });
    expect(posts).toEqual([]);
    expect(await filesNamed(directory, 'a-op-1.json')).toHaveLength(1);

    const rotated = agent(directory, 'key-a-rotated', posts);
    const resumedOwn = await rotated.run(['operation', 'resume']);
    expect(resumedOwn.code).toBe(0);
    expect(posts).toEqual([
      { token: 'Bearer key-a-rotated', operationId: 'a-op-1' },
    ]);
    expect(resumedOwn.last).toMatchObject({ ok: true, operationId: 'a-op-1' });
    expect(await filesNamed(directory, 'a-op-1.json')).toEqual([]);
  });

  it('TI-039: a corrupt or foreign file in the outbox does not block reads and is reported instead', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-outbox-'));
    const posts: Post[] = [];
    const a = agent(directory, 'key-a', posts);
    a.offline();
    await a.run([
      'comment',
      'add',
      't1',
      '--text',
      'Первый конверт',
      '--operation-id',
      'seed',
    ]);
    const [seed] = await filesNamed(directory, 'seed.json');
    expect(seed).toBeDefined();
    const ops = dirname(seed!);
    await writeFile(join(ops, 'zzz.json'), '{not json');
    await writeFile(join(ops, 'bad name.json'), '{}');
    await writeFile(join(ops, '.pending-old'), '{}');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(ops, '.pending-old'), twoHoursAgo, twoHoursAgo);
    // An envelope of the previous layout (formatVersion 1) is reported, never sent.
    const legacy = join(directory, 'taskindex', 'ops');
    await mkdir(legacy, { recursive: true });
    await writeFile(
      join(legacy, 'old-1.json'),
      `${JSON.stringify({
        formatVersion: 1,
        baseUrl: BASE_URL,
        endpoint: '/api/commands',
        envelope: {
          operationId: 'old-1',
          generation: 'g0',
          command: 'comment.add',
          payload: { taskId: 't1', text: 'Старый конверт' },
        },
      })}\n`,
    );

    a.online();
    const read = await a.run(['tasks']);
    expect(read.code).toBe(0);
    expect(read.last).toMatchObject({ items: [] });
    expect(posts).toEqual([]);
    const warnings = read.errors.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const skipped = warnings.filter((w) => w.warning === 'outbox_skipped');
    expect(skipped.map((w) => String(w.file)).sort()).toEqual([
      join(ops, 'bad name.json'),
      join(ops, 'zzz.json'),
    ]);
    expect(warnings.find((w) => w.warning === 'legacy_outbox')).toMatchObject({
      files: ['old-1.json'],
    });
    expect(
      warnings.find((w) => Array.isArray(w.pendingOperations)),
    ).toMatchObject({ pendingOperations: ['seed'] });
    expect(await readFile(join(ops, 'zzz.json.corrupt'), 'utf8')).toBe(
      '{not json',
    );
    await expect(stat(join(ops, 'zzz.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(ops, '.pending-old'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(ops, 'bad name.json'), 'utf8')).toBe('{}');

    const listed = await a.run(['operation', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.last).toMatchObject({
      ok: true,
      pending: [{ operationId: 'seed', command: 'comment.add' }],
    });
    const corrupt = listed.last!.corrupt as { file: string }[];
    expect(corrupt.map((c) => c.file).sort()).toEqual([
      join(ops, 'bad name.json'),
      join(ops, 'zzz.json.corrupt'),
    ]);

    const resumed = await a.run(['operation', 'resume']);
    expect(resumed.code).toBe(0);
    expect(posts).toEqual([{ token: 'Bearer key-a', operationId: 'seed' }]);
    expect(await filesNamed(directory, 'seed.json')).toEqual([]);
    expect(await filesNamed(directory, 'old-1.json')).toHaveLength(1);
  });
});
