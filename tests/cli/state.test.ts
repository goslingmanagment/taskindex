import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { serverId, statePaths, tokenHash } from '../../src/cli/state.js';

const actor = {
  id: 'agent:test',
  agentId: 'test',
  label: 'Тест',
  kind: 'agent',
  scope: 'write',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(directory: string, baseUrl: string, token: string) {
  const env = {
    TASKINDEX_URL: baseUrl,
    TASKINDEX_TOKEN: token,
    XDG_STATE_HOME: directory,
  };
  const calls: string[] = [];
  const posts: string[] = [];
  const state = { meAvailable: true, postAvailable: true };
  const requestFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/me') {
      if (!state.meAvailable) throw new TypeError('network down');
      return json(actor);
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
      if (!state.postAvailable) throw new TypeError('network down');
      const envelope = (await request.json()) as { operationId: string };
      posts.push(envelope.operationId);
      return json({
        ok: true,
        operationId: envelope.operationId,
        generation: 'g1',
        firstSeq: null,
        lastSeq: null,
        results: [{ record: null, changes: {} }],
        events: [],
      });
    }
    throw new Error(`Unexpected ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  return {
    env,
    calls,
    posts,
    state,
    paths: statePaths(env, baseUrl),
    async run(argv: string[]) {
      const output: Record<string, unknown>[] = [];
      const errors: Record<string, unknown>[] = [];
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
  };
}

const BASE = 'https://taskindex.example';
const write = (id: string, extra: string[] = []) => [
  'comment',
  'add',
  't1',
  '--text',
  'Отчёт',
  '--operation-id',
  id,
  ...extra,
];

describe('CLI state layout per server and agent', () => {
  it('caches the identity by key hash without the token and reuses it on later runs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-state-'));
    const cli = harness(directory, BASE, 'secret-token');
    expect((await cli.run(['tasks'])).code).toBe(0);
    const cache = join(
      cli.paths.identities,
      `${tokenHash('secret-token')}.json`,
    );
    const text = await readFile(cache, 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      formatVersion: 1,
      actorId: 'agent:test',
      agentId: 'test',
      scope: 'write',
    });
    expect(text).not.toContain('secret-token');
    expect((await stat(cache)).mode & 0o777).toBe(0o600);
    expect(cli.paths.server).toBe(
      join(directory, 'taskindex', 'servers', serverId(BASE)),
    );
    expect(cli.calls.filter((call) => call === 'GET /api/me')).toHaveLength(1);
    await cli.run(['tasks']);
    expect(cli.calls.filter((call) => call === 'GET /api/me')).toHaveLength(1);
  });

  it('keeps envelopes under the key hash while the identity is unknown and adopts them once /api/me answers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-state-'));
    const cli = harness(directory, BASE, 'secret-token');
    cli.state.meAvailable = false;
    cli.state.postAvailable = false;
    const held = await cli.run(write('fallback-1', ['--generation', 'g1']));
    expect(held.code).toBe(1);
    expect(held.last).toMatchObject({
      status: 'unknown',
      operationId: 'fallback-1',
    });
    expect(
      held.errors.find((w) => w.warning === 'identity_unknown'),
    ).toMatchObject({
      reason: 'network',
    });
    const fallback = cli.paths.ops(`key-${tokenHash('secret-token')}`);
    const saved = JSON.parse(
      await readFile(join(fallback, 'fallback-1.json'), 'utf8'),
    );
    expect(saved).toMatchObject({
      formatVersion: 2,
      actorId: `key:${tokenHash('secret-token')}`,
      envelope: { operationId: 'fallback-1', generation: 'g1' },
    });
    expect(JSON.stringify(saved)).not.toContain('secret-token');

    cli.state.meAvailable = true;
    cli.state.postAvailable = true;
    const resumed = await cli.run(['operation', 'resume']);
    expect(resumed.code).toBe(0);
    expect(cli.posts).toEqual(['fallback-1']);
    expect(resumed.last).toMatchObject({ ok: true, operationId: 'fallback-1' });
    expect(await readdir(fallback)).toEqual([]);
    expect(await readdir(cli.paths.ops('test'))).toEqual([]);
  });

  it('separates servers, quarantines unreadable envelopes and never resends a file saved by another actor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-state-'));
    const cli = harness(directory, BASE, 'secret-token');
    const other = harness(directory, 'https://other.example', 'secret-token');
    cli.state.postAvailable = false;
    await cli.run(write('own-1'));
    const ops = cli.paths.ops('test');
    const ownBytes = await readFile(join(ops, 'own-1.json'), 'utf8');
    await writeFile(
      join(ops, 'foreign-1.json'),
      `${JSON.stringify({ ...JSON.parse(ownBytes), actorId: 'agent:other', envelope: { ...JSON.parse(ownBytes).envelope, operationId: 'foreign-1' } })}\n`,
    );
    await writeFile(
      join(ops, 'v1-1.json'),
      JSON.stringify({
        formatVersion: 1,
        baseUrl: BASE,
        endpoint: '/api/commands',
        envelope: {
          operationId: 'v1-1',
          generation: 'g1',
          command: 'comment.add',
          payload: { taskId: 't1', text: 'x' },
        },
      }),
    );
    await writeFile(
      join(ops, 'null-1.json'),
      JSON.stringify({
        formatVersion: 2,
        baseUrl: BASE,
        endpoint: '/api/commands',
        actorId: 'agent:test',
        envelope: null,
      }),
    );
    await mkdir(other.paths.ops('test'), { recursive: true });

    const read = await other.run(['tasks']);
    expect(read.code).toBe(0);
    expect(
      read.errors.find((w) => Array.isArray(w.pendingOperations)),
    ).toBeUndefined();

    cli.state.postAvailable = true;
    const listed = await cli.run(['operation', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.last).toMatchObject({
      ok: true,
      actorId: 'agent:test',
      agentId: 'test',
      directory: ops,
      pending: [{ operationId: 'own-1', command: 'comment.add' }],
    });
    const corrupt = listed.last!.corrupt as { file: string; reason: string }[];
    expect(
      corrupt.map((entry) => `${entry.reason} ${entry.file}`).sort(),
    ).toEqual([
      `actor ${join(ops, 'foreign-1.json')}`,
      `schema ${join(ops, 'null-1.json.corrupt')}`,
      `schema ${join(ops, 'v1-1.json.corrupt')}`,
    ]);
    expect(await readFile(join(ops, 'own-1.json'), 'utf8')).toBe(ownBytes);

    expect((await cli.run(['operation', 'resume', 'foreign-1'])).code).toBe(2);
    expect((await cli.run(['operation', 'resume', 'v1-1'])).code).toBe(2);
    const resumed = await cli.run(['operation', 'resume']);
    expect(resumed.code).toBe(0);
    expect(cli.posts).toEqual(['own-1']);
    expect((await readdir(ops)).sort()).toEqual([
      'foreign-1.json',
      'null-1.json.corrupt',
      'v1-1.json.corrupt',
    ]);
    // A later run lists the quarantined files again without repeating the rename.
    const again = await cli.run(['operation', 'list']);
    expect(
      (again.last!.corrupt as { reason: string }[]).map((c) => c.reason).sort(),
    ).toEqual(['actor', 'corrupt', 'corrupt']);
  });
});
