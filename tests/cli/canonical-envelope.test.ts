import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { Outbox, sameOperation } from '../../src/cli/outbox.js';
import { statePaths } from '../../src/cli/state.js';
import { readOperations } from '../../src/server/db.js';
import { canonicalJson } from '../../src/shared/canonical-json.js';
import { fixture } from '../api/helpers.js';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

// TI-061: one canonical JSON for the whole product. The envelope the CLI
// persists and sends must hash to exactly the `commandHash` the server stores,
// otherwise a resend of the same intent would look like a different operation.
describe('canonical form of a CLI envelope (TI-061)', () => {
  it('hashes to the commandHash the server stored for the same operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskindex-canonical-'));
    const served = fixture();
    const sent: unknown[] = [];
    const transport = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      request.headers.set('x-test-role', 'agent');
      if (request.method === 'POST') sent.push(await request.clone().json());
      return served.app.request(request);
    }) as typeof fetch;
    const env = {
      TASKINDEX_URL: 'http://localhost:3001',
      TASKINDEX_TOKEN: 'agent-key',
      XDG_STATE_HOME: directory,
    };
    try {
      const code = await runCli(
        [
          'task',
          'create',
          '--title',
          'Ключи в разном порядке «ёлка»',
          '--area',
          'agency',
          '--note',
          'строка с \\ и "кавычками"',
          '--operation-id',
          'op-canonical-1',
        ],
        {
          env,
          fetch: transport,
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );
      expect(code).toBe(0);
      expect(sent).toHaveLength(1);
      const stored = readOperations(served.db).find(
        (operation) => operation.id === 'op-canonical-1',
      );
      expect(stored).toBeDefined();
      expect(sha256(canonicalJson(sent[0]))).toBe(stored!.commandHash);
      // The saved envelope is settled and removed once the server confirmed it.
      const outbox = new Outbox(
        statePaths(env, env.TASKINDEX_URL).ops('test-agent'),
      );
      expect(await outbox.get('op-canonical-1')).toBeUndefined();
    } finally {
      served.close();
    }
  });

  it('keeps one canonical implementation: the CLI has no local key sorter', async () => {
    const source = await readFile('src/cli/outbox.ts', 'utf8');
    expect(source).toContain("from '../shared/canonical-json.js'");
    expect(source).not.toMatch(/function canonical\s*\(/);
    expect(source).not.toContain('localeCompare');
  });

  it('compares saved operations by the shared canonical form, not by key order', () => {
    const base = {
      formatVersion: 2 as const,
      baseUrl: 'http://localhost:3001',
      endpoint: '/api/commands' as const,
      actorId: 'agent:test-agent',
      savedAt: '2026-09-10T10:00:00.000Z',
      envelope: {
        operationId: 'op-1',
        generation: 'g1',
        command: 'task.create' as const,
        payload: { title: 'Задача', area: 'agency' as const },
      },
    };
    const permuted = {
      envelope: {
        payload: { area: 'agency' as const, title: 'Задача' },
        command: 'task.create' as const,
        generation: 'g1',
        operationId: 'op-1',
      },
      actorId: 'agent:test-agent',
      endpoint: '/api/commands' as const,
      baseUrl: 'http://localhost:3001',
      formatVersion: 2 as const,
      savedAt: '2026-09-11T10:00:00.000Z',
    };
    expect(sameOperation(base, permuted)).toBe(true);
    expect(
      sameOperation(base, {
        ...base,
        envelope: {
          ...base.envelope,
          payload: { title: 'Другая', area: 'agency' as const },
        },
      }),
    ).toBe(false);
    expect(canonicalJson(base.envelope)).toBe(canonicalJson(permuted.envelope));
  });
});
