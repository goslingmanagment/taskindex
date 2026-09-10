// @ts-check
// Offline helpers on the SQLite file inside the image: inspect, backup (SQLite backup API),
// quarantine-and-install (restore). Only node: APIs plus better-sqlite3 from the image.
import Database from 'better-sqlite3';
import { mkdir, access, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const [command, argument] = process.argv.slice(2);
const source = process.env.DATABASE_PATH || '/data/taskindex.db';
/** @param {import('better-sqlite3').Database} db */
const inspect = (db) => {
  const rows = /** @type {{ key: string, value: string }[]} */ (
    db.prepare('SELECT key, value FROM settings').all()
  );
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const { seq } = /** @type {{ seq: number }} */ (
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()
  );
  return {
    generation: settings.generation,
    schemaVersion: Number(settings.schema_version),
    seq,
  };
};
/** @param {import('better-sqlite3').Database} db */
const integrityOk = (db) =>
  db.pragma('integrity_check', { simple: true }) === 'ok' &&
  /** @type {unknown[]} */ (db.pragma('foreign_key_check')).length === 0;
/** @param {unknown} error */
const errorCode = (error) => /** @type {{ code?: string }} */ (error)?.code;

try {
  if (command === 'backup' || command === 'inspect') {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      const metadata = inspect(db);
      if (!integrityOk(db)) throw new Error('Database integrity check failed');
      if (command === 'backup') {
        if (!argument || !resolve(argument).startsWith('/data/backups/'))
          throw new Error('Backup output must be inside /data/backups/');
        await mkdir(dirname(argument), { recursive: true, mode: 0o700 });
        try {
          await access(argument);
          throw new Error('Backup already exists');
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
        await db.backup(argument);
        const check = new Database(argument, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          if (!integrityOk(check))
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
      if (!integrityOk(check))
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
      // Ж13: sidecar с generation прежней базы. Если оставить его рядом,
      // подставленная копия будет сверяться с чужим значением.
      `${source}.generation`,
      join(dirname(source), '.taskindex.db-litestream'),
    ]) {
      try {
        await rename(path, join(quarantine, basename(path)));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    await rename(standalone, source);
    await writeFile(
      join(quarantine, 'RESTORE.json'),
      JSON.stringify({ source: argument, installed: source }),
      { mode: 0o600, flag: 'wx' },
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        quarantine,
        next: 'mark-restored using the matching image; configure a new empty replica prefix before starting Litestream',
      })}\n`,
    );
  } else
    throw new Error(
      'Usage: database.mjs inspect | backup /data/backups/NAME.db | quarantine-and-install PATH',
    );
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Database operation failed' })}\n`,
  );
  process.exitCode = 1;
}
