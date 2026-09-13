import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

// TI-088: the backup helper re-opens the fresh copy for an integrity check. A copy of a
// WAL-mode database must not leave `-wal`/`-shm` side files next to itself afterwards,
// and must stay a single standalone file for whoever opens it later.
describe('database.mjs backup', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'taskindex-backup-'));
    const db = new Database(join(dir, 'source.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY);
      INSERT INTO settings VALUES ('generation', 'g-1'), ('schema_version', '6');
      INSERT INTO events (seq) VALUES (1), (2);`);
    db.close();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('TI-088 leaves a single standalone file without WAL side files', async () => {
    const backups = join(dir, 'backups');
    const copy = join(backups, 'copy.db');
    const { stdout } = await run(
      process.execPath,
      ['deploy/database.mjs', 'backup', copy],
      {
        env: {
          ...process.env,
          DATABASE_PATH: join(dir, 'source.db'),
          TASKINDEX_BACKUP_ROOT: backups,
        },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      generation: 'g-1',
      schemaVersion: 6,
      seq: 2,
      path: copy,
    });
    expect((await readdir(backups)).sort()).toEqual(['copy.db']);
    const check = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      expect(check.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(check.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({
        n: 2,
      });
    } finally {
      check.close();
    }
    expect((await readdir(backups)).sort()).toEqual(['copy.db']);
  });
});
