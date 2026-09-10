import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAdmin } from '../../src/cli/admin-run.js';
import { openDatabase } from '../../src/server/db.js';
import { writesAreOpen } from '../../src/server/admin.js';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-admin-'));
  const output: Record<string, unknown>[] = [];
  const env = {
    DATABASE_PATH: join(directory, 'test.db'),
    TASKINDEX_MIGRATIONS_DIR: resolve('drizzle/v2'),
    TASKINDEX_DEPLOYMENT: 'deploy-one',
  };
  return {
    directory,
    env,
    output,
    run: (argv: string[]) =>
      runAdmin(argv, {
        env,
        stdout: (line) =>
          output.push(JSON.parse(line) as Record<string, unknown>),
        readInput: async () => 'local-test-password-1234\n',
      }),
  };
}

describe('server-only administration', () => {
  it('bootstraps one owner without printing or storing plaintext passwords', async () => {
    const test = await setup();
    expect(await test.run(['migrate'])).toBe(0);
    expect(
      await test.run(['create-owner', '--email', 'owner@example.test']),
    ).toBe(0);
    expect(
      await test.run(['create-owner', '--email', 'other@example.test']),
    ).toBe(3);
    expect(JSON.stringify(test.output)).not.toContain('local-test-password');
    const db = openDatabase(test.env.DATABASE_PATH);
    try {
      const account = db.sqlite
        .prepare('SELECT password FROM account')
        .get() as { password: string };
      expect(account.password).not.toContain('local-test-password');
      expect(db.sqlite.prepare('SELECT count(*) AS n FROM user').get()).toEqual(
        { n: 1 },
      );
    } finally {
      db.close();
    }
    expect(await test.run(['reset-owner-password'])).toBe(0);
  });

  it('persists approval for the same deployment and clears it after mark-restored', async () => {
    const test = await setup();
    await test.run(['migrate']);
    const before = test.output.at(-1)?.generation;
    expect(await test.run(['open-writes'])).toBe(0);
    let db = openDatabase(test.env.DATABASE_PATH);
    expect(writesAreOpen(db, 'held', 'deploy-one')).toBe(true);
    expect(writesAreOpen(db, 'held', 'deploy-two')).toBe(false);
    db.close();
    expect(await test.run(['mark-restored'])).toBe(0);
    expect(test.output.at(-1)?.generation).not.toBe(before);
    db = openDatabase(test.env.DATABASE_PATH);
    expect(writesAreOpen(db, 'held', 'deploy-one')).toBe(false);
    db.close();
  });

  it('keeps key material out of stdout and creates a private one-time file', async () => {
    const test = await setup();
    await test.run(['migrate']);
    await test.run(['create-owner', '--email', 'owner@example.test']);
    expect(
      await test.run(['agent', 'create', '--id', 'claude', '--label', 'Клод']),
    ).toBe(0);
    const destination = join(test.directory, 'key.json');
    expect(
      await test.run([
        'agent-key',
        'create',
        '--agent',
        'claude',
        '--scope',
        'write',
        '--out',
        destination,
      ]),
    ).toBe(0);
    const key = JSON.parse(await readFile(destination, 'utf8')) as {
      key: string;
      id: string;
    };
    expect(key.key.length).toBeGreaterThan(10);
    expect(key.key.startsWith('ti_')).toBe(true);
    expect(JSON.stringify(test.output)).not.toContain(key.key);
    expect(test.output.at(-1)).toEqual({
      id: key.id,
      agentId: 'claude',
      scope: 'write',
      path: destination,
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await test.run(['agent-key', 'list', '--agent', 'claude'])).toBe(0);
    expect(JSON.stringify(test.output)).not.toContain(key.key);
    expect(test.output.at(-1)).toEqual([
      expect.objectContaining({ id: key.id, scope: 'write', revokedAt: null }),
    ]);
    // A second key cannot overwrite the protected file; it is revoked at once.
    expect(
      await test.run([
        'agent-key',
        'create',
        '--agent',
        'claude',
        '--scope',
        'read',
        '--out',
        destination,
      ]),
    ).toBe(1);
    expect(JSON.stringify(test.output)).not.toContain('ti_');
    expect(await test.run(['agent-key', 'list', '--agent', 'claude'])).toBe(0);
    const listed = test.output.at(-1) as unknown as {
      id: string;
      revokedAt: string | null;
    }[];
    expect(listed).toHaveLength(2);
    expect(listed.find((k) => k.id !== key.id)?.revokedAt).toEqual(
      expect.any(String),
    );
    expect(await test.run(['agent-key', 'revoke', key.id])).toBe(0);
    expect(await test.run(['agent-key', 'list', '--agent', 'claude'])).toBe(0);
    expect(test.output.at(-1)).toEqual([
      expect.objectContaining({ id: key.id, revokedAt: expect.any(String) }),
      expect.objectContaining({ revokedAt: expect.any(String) }),
    ]);
  });
});
