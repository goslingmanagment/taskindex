import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';

const actor = {
  id: 'agent:test',
  agentId: 'test',
  label: 'Тест',
  kind: 'agent',
  scope: 'read',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const conflict = () =>
  json(
    {
      ok: false,
      code: 'conflict',
      message: 'Данные изменились. Начните чтение страниц заново.',
      retryable: false,
    },
    409,
  );

const page = (
  seq: number,
  ids: string[],
  next: string | null,
  generation = 'g1',
) =>
  json({
    generation,
    seq,
    items: ids.map((id) => ({ id })),
    more: next !== null,
    nextCursor: next,
  });

// The handler sees the request sequence; each entry answers one request.
async function walk(
  responses: ((url: URL) => Response)[],
  argv: string[] = ['tasks', '--all', '--limit', '1'],
) {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-reads-'));
  const output: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const urls: string[] = [];
  let index = 0;
  const requestFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/api/me') return json(actor);
    urls.push(`${url.pathname}${url.search}`);
    const answer = responses[index] ?? responses.at(-1)!;
    index += 1;
    return answer(url);
  }) as typeof fetch;
  const code = await runCli(argv, {
    env: {
      TASKINDEX_URL: 'https://taskindex.example',
      TASKINDEX_TOKEN: 'secret',
      XDG_STATE_HOME: directory,
    },
    fetch: requestFetch,
    stdout: (line) => output.push(JSON.parse(line) as Record<string, unknown>),
    stderr: (line) => errors.push(JSON.parse(line) as Record<string, unknown>),
    sleep: async () => undefined,
  });
  return { code, output, errors, urls, requests: index };
}

describe('--all walks every page and restarts after a cursor conflict (TI-037)', () => {
  it('restarts from the first page after 409 conflict and prints each page once', async () => {
    const result = await walk([
      () => page(10, ['a'], 'c1'),
      conflict,
      () => page(11, ['a'], 'c2'),
      () => page(11, ['b'], null),
    ]);
    expect(result.code).toBe(0);
    expect(result.output.map((line) => line.items)).toEqual([
      [{ id: 'a' }],
      [{ id: 'b' }],
    ]);
    expect(result.urls).toEqual([
      '/api/tasks?limit=1',
      '/api/tasks?limit=1&cursor=c1&generation=g1',
      '/api/tasks?limit=1',
      '/api/tasks?limit=1&cursor=c2&generation=g1',
    ]);
    expect(result.errors).toContainEqual({
      restart: 1,
      reason: 'cursor_conflict',
    });
    expect(
      result.errors.find((line) => line.warning === 'list_changed_during_walk'),
    ).toBeUndefined();
  });

  it('gives up after three restarts with the server reply and exit code 3, printing no partial pages', async () => {
    const result = await walk([
      () => page(10, ['a'], 'c1'),
      conflict,
      () => page(11, ['a'], 'c1'),
      conflict,
      () => page(12, ['a'], 'c1'),
      conflict,
      () => page(13, ['a'], 'c1'),
      conflict,
    ]);
    expect(result.code).toBe(3);
    expect(result.requests).toBe(8);
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ ok: false, code: 'conflict' });
    expect(
      result.errors.filter((line) => line.reason === 'cursor_conflict'),
    ).toEqual([
      { restart: 1, reason: 'cursor_conflict' },
      { restart: 2, reason: 'cursor_conflict' },
      { restart: 3, reason: 'cursor_conflict' },
    ]);
  });

  it('warns when the list changed between the first and the last page, still printing every page', async () => {
    const result = await walk([
      () => page(10, ['a'], 'c1'),
      () => page(10, ['b'], 'c2'),
      () => page(12, ['c'], null),
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toHaveLength(3);
    expect(result.errors).toContainEqual({
      warning: 'list_changed_during_walk',
      fromSeq: 10,
      toSeq: 12,
    });
  });

  it('forwards a keyset cursor of the server (v: 2) verbatim, without re-encoding it', async () => {
    // The CLI never parses a cursor: the server's base64url of
    // {v:2,generation,query,key} has to reach the next request unchanged.
    const cursor = Buffer.from(
      JSON.stringify({
        v: 2,
        generation: 'g1',
        query: 'tasks:',
        key: { orderKey: 'm', id: 'a' },
      }),
    ).toString('base64url');
    const result = await walk([
      () => page(10, ['a'], cursor),
      () => page(10, ['b'], null),
    ]);
    expect(result.code).toBe(0);
    expect(result.urls[1]).toBe(
      `/api/tasks?limit=1&cursor=${cursor}&generation=g1`,
    );
    expect(result.output.map((line) => line.items)).toEqual([
      [{ id: 'a' }],
      [{ id: 'b' }],
    ]);
    expect(
      result.errors.find((line) => line.warning === 'list_changed_during_walk'),
    ).toBeUndefined();
  });

  it('does not restart on generation_changed or without --all', async () => {
    const changed = await walk([
      () => page(10, ['a'], 'c1'),
      () =>
        json(
          {
            ok: false,
            code: 'generation_changed',
            message: 'Поколение базы изменилось.',
            retryable: false,
            generation: 'g2',
          },
          409,
        ),
    ]);
    expect(changed.code).toBe(3);
    expect(changed.requests).toBe(2);
    expect(changed.output.at(-1)).toMatchObject({ code: 'generation_changed' });
    expect(String(changed.output.at(-1)!.hint)).toContain('cursor reset');
    expect(
      changed.errors.find((line) => line.reason === 'cursor_conflict'),
    ).toBeUndefined();

    const single = await walk([conflict], ['tasks', '--cursor', 'stale']);
    expect(single.code).toBe(3);
    expect(single.requests).toBe(1);
    expect(single.output.at(-1)).toMatchObject({ code: 'conflict' });
  });
});
