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

async function follow(
  pages: (() => Response)[],
  argv: string[] = ['events', '--follow', '--since', '0', '--generation', 'g1'],
) {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-follow-'));
  const controller = new AbortController();
  const output: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const urls: string[] = [];
  let index = 0;
  const requestFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/api/me') return json(actor);
    urls.push(`${url.pathname}${url.search}`);
    const page = pages[index] ?? pages.at(-1)!;
    index += 1;
    if (index >= pages.length) controller.abort();
    return page();
  }) as typeof fetch;
  const code = await runCli(argv, {
    env: {
      TASKINDEX_URL: 'https://taskindex.example',
      TASKINDEX_TOKEN: 'secret',
      XDG_STATE_HOME: directory,
    },
    fetch: requestFetch,
    stdout: (line) => output.push(JSON.parse(line) as Record<string, unknown>),
    stderr: () => undefined,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    signal: controller.signal,
  });
  return { code, output, sleeps, urls };
}

describe('events --follow', () => {
  it('TI-051: prints only pages with events and keeps polling from the last cursor', async () => {
    const empty = () =>
      json({ generation: 'g1', latestSeq: 0, more: false, events: [] });
    const result = await follow([
      empty,
      empty,
      () =>
        json({
          generation: 'g1',
          latestSeq: 1,
          more: false,
          events: [event(1)],
        }),
      empty,
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ events: [{ seq: 1 }] });
    expect(result.urls.at(-1)).toContain('since=1');
    expect(result.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('honours --interval with a floor of 250 ms', async () => {
    const empty = () =>
      json({ generation: 'g1', latestSeq: 0, more: false, events: [] });
    const result = await follow(
      [empty, empty],
      [
        'events',
        '--follow',
        '--since',
        '0',
        '--generation',
        'g1',
        '--interval',
        '100',
      ],
    );
    expect(result.code).toBe(0);
    expect(result.output).toEqual([]);
    expect(result.sleeps).toEqual([250]);
  });

  it('never hides an error page behind the empty-page filter', async () => {
    const result = await follow([
      () => json({ generation: 'g1', latestSeq: 0, more: false, events: [] }),
      () =>
        json(
          {
            ok: false,
            code: 'generation_changed',
            message: 'База восстановлена',
            retryable: false,
          },
          409,
        ),
      () => json({ generation: 'g2', latestSeq: 0, more: false, events: [] }),
    ]);
    expect(result.code).toBe(3);
    expect(result.output).toEqual([
      {
        ok: false,
        code: 'generation_changed',
        message: 'База восстановлена',
        retryable: false,
      },
    ]);
  });
});
