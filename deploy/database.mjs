import Database from 'better-sqlite3';
import { mkdir, access, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const [command, argument] = process.argv.slice(2);
const source = process.env.DATABASE_PATH || '/data/taskindex.db';
const inspect = (db) => {
  const settings = Object.fromEntries(
    db
      .prepare('SELECT key, value FROM settings')
      .all()
      .map((row) => [row.key, row.value]),
  );
  const seq = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
    .get().seq;
  return {
    generation: settings.generation,
    schemaVersion: Number(settings.schema_version),
    seq,
  };
};

try {
  if (command === 'backup' || command === 'inspect') {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      const metadata = inspect(db);
      if (
        db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        db.pragma('foreign_key_check').length
      )
        throw new Error('Database integrity check failed');
      if (command === 'backup') {
        if (!argument || !resolve(argument).startsWith('/data/backups/'))
          throw new Error('Backup output must be inside /data/backups/');
        await mkdir(dirname(argument), { recursive: true, mode: 0o700 });
        try {
          await access(argument);
          throw new Error('Backup already exists');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await db.backup(argument);
        const check = new Database(argument, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          if (
            check.pragma('integrity_check', { simple: true }) !== 'ok' ||
            check.pragma('foreign_key_check').length
          )
            throw new Error('Backup integrity check failed');
        } finally {
          check.close();
        }
      }
      process.stdout.write(
        `${JSON.stringify({ ok: true, ...metadata, ...(argument ? { path: argument } : {}) })}\n`,
      );
    } finally {
      db.close();
    }
  } else if (
    command === 'quarantine-and-install' ||
    command === 'install-restore'
  ) {
    if (
      process.env.TASKINDEX_OFFLINE_RESTORE !== 'confirmed-no-open-connections'
    )
      throw new Error('Offline restore confirmation is missing');
    if (!argument || resolve(argument) === resolve(source))
      throw new Error('An independent backup path is required');
    const check = new Database(argument, {
      readonly: true,
      fileMustExist: true,
    });
    const standalone = join(dirname(source), `.restore-${randomUUID()}.db`);
    try {
      if (
        check.pragma('integrity_check', { simple: true }) !== 'ok' ||
        check.pragma('foreign_key_check').length
      )
        throw new Error('Restore integrity check failed');
      // Materialize through SQLite, so even a source accompanied by its own WAL
      // produces an independent database before any current file is moved.
      await check.backup(standalone);
    } finally {
      check.close();
    }
    const quarantine = join(
      dirname(source),
      'backups',
      `before-restore-${Date.now()}`,
    );
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    for (const path of [
      source,
      `${source}-wal`,
      `${source}-shm`,
      `${source}-journal`,
      join(dirname(source), '.taskindex.db-litestream'),
    ]) {
      try {
        await rename(path, join(quarantine, path.split('/').at(-1)));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await rename(standalone, source);
    await writeFile(
      join(quarantine, 'RESTORE.json'),
      JSON.stringify({ source: argument, installed: source }),
      { mode: 0o600, flag: 'wx' },
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, quarantine, next: 'mark-restored using the matching image; configure a new empty replica prefix before starting Litestream' })}\n`,
    );
  } else
    throw new Error(
      'Usage: database.mjs inspect | backup /data/backups/NAME.db | install-restore PATH',
    );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Database operation failed' })}\n`,
  );
  process.exitCode = 1;
}
