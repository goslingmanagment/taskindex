import {
  openDatabase,
  migrate,
} from '/Users/dmitriy/code/taskindex/src/server/db.ts';
import { statSync, existsSync } from 'node:fs';
const dir = process.argv[2];
const path = `${dir}/probe.db`;
const db = openDatabase(path);
migrate(db);
db.sqlite.pragma('wal_autocheckpoint = 0');
db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
const wal = () =>
  existsSync(path + '-wal') ? statSync(path + '-wal').size : 0;
const dv = () =>
  (db.sqlite.prepare('PRAGMA data_version').get() as any).data_version;
const w0 = wal(),
  d0 = dv();
for (let i = 0; i < 20; i++)
  db.sqlite
    .prepare("UPDATE settings SET value=value WHERE key='generation'")
    .run();
const w1 = wal(),
  d1 = dv();
const changes = db.sqlite
  .prepare("UPDATE settings SET value=value WHERE key='generation'")
  .run().changes;
for (let i = 0; i < 5; i++)
  db.sqlite
    .prepare("UPDATE settings SET value=value||'' WHERE key='timezone'")
    .run();
const w2 = wal();
db.sqlite
  .prepare("UPDATE settings SET value=value||'x' WHERE key='timezone'")
  .run();
const w3 = wal(),
  d3 = dv();
console.log(
  JSON.stringify({
    noopUpdates20: {
      walDelta: w1 - w0,
      dataVersionDelta: d1 - d0,
      changesReported: changes,
    },
    concatEmpty5: { walDelta: w2 - w1 },
    realUpdate1: { walDelta: w3 - w2, dataVersionDelta: d3 - d1 },
  }),
);
db.close();
