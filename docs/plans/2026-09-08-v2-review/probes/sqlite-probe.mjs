import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
console.log('node', process.version, 'bundled sqlite', process.versions.sqlite);
const dir = mkdtempSync(join(tmpdir(), 'ti-probe-'));
const p = join(dir, 'a.db');
const db = new DatabaseSync(p);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=FULL');
db.exec('PRAGMA foreign_keys=ON');
db.exec('PRAGMA busy_timeout=5000');
console.log(
  'journal_mode',
  db.prepare('PRAGMA journal_mode').get(),
  'sync',
  db.prepare('PRAGMA synchronous').get(),
);
db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.prepare('INSERT INTO settings VALUES(?,?)').run('generation', 'g1');
const api = {
  backup: typeof db.backup,
  prepare: typeof db.prepare,
  exec: typeof db.exec,
  isTransaction: 'isTransaction' in db,
  applyChangeset: typeof db.applyChangeset,
  location: typeof db.location,
};
console.log('DatabaseSync API', JSON.stringify(api));
// no-op UPDATE: does it grow the WAL (i.e. real write + fsync)?
const wal = p + '-wal';
const before = existsSync(wal) ? statSync(wal).size : 0;
for (let i = 0; i < 5; i++)
  db.prepare("UPDATE settings SET value=value WHERE key='generation'").run();
const after = existsSync(wal) ? statSync(wal).size : 0;
console.log(
  'WAL bytes before no-op updates',
  before,
  'after 5 no-op updates',
  after,
  '=> per update',
  (after - before) / 5,
);
db.close();
