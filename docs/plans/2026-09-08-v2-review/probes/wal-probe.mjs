import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path'; import { tmpdir } from 'node:os';
const require = createRequire('/Users/dmitriy/code/taskindex/package.json');
const BS3 = require('better-sqlite3');
function walSize(p){const w=p+'-wal';return existsSync(w)?statSync(w).size:0;}
function run(label, open){
  const dir = mkdtempSync(join(tmpdir(), 'ti-wal-')); const p = join(dir,'a.db');
  const { exec, run, get, close } = open(p);
  exec('PRAGMA journal_mode=WAL'); exec('PRAGMA synchronous=FULL'); exec('PRAGMA wal_autocheckpoint=0');
  exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  run("INSERT INTO settings VALUES('generation','g1')");
  const reader = new DatabaseSync(p, { readOnly: true });
  const dv = () => reader.prepare('PRAGMA data_version').get().data_version;
  const s0 = walSize(p), d0 = dv();
  for (let i=0;i<5;i++) run("UPDATE settings SET value=value WHERE key='generation'");
  const s1 = walSize(p), d1 = dv();
  for (let i=0;i<5;i++) run("UPDATE settings SET value=value||'x' WHERE key='generation'");
  const s2 = walSize(p), d2 = dv();
  console.log(label, JSON.stringify({ noop: { walDelta: s1-s0, dataVersionDelta: d1-d0 }, real: { walDelta: s2-s1, dataVersionDelta: d2-d1 } }));
  reader.close(); close();
}
run('node:sqlite  ', (p)=>{const db=new DatabaseSync(p);return {exec:s=>db.exec(s),run:s=>db.prepare(s).run(),get:s=>db.prepare(s).get(),close:()=>db.close()};});
run('better-sqlite3', (p)=>{const db=new BS3(p);return {exec:s=>db.exec(s),run:s=>db.prepare(s).run(),get:s=>db.prepare(s).get(),close:()=>db.close()};});
