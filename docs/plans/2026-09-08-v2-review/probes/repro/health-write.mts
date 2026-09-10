// R4: /health performs a real write transaction on every call
import { openDatabase, migrate } from '/Users/dmitriy/code/taskindex/src/server/db.ts';
import { createApp } from '/Users/dmitriy/code/taskindex/src/server/app.ts';
import { statSync } from 'node:fs';
const path = '/private/tmp/claude-501/-Users-dmitriy-code-taskindex/c5cd56f9-7e33-4f1e-8f89-5a82fb964e56/scratchpad/repro/health.db';
const db = openDatabase(path);
migrate(db, { migrationsDir: '/Users/dmitriy/code/taskindex/drizzle/v2' });
db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
const app = createApp({ db, authorize: () => null });
const before = statSync(path + '-wal').size;
const changes = db.sqlite.prepare("UPDATE settings SET value=value WHERE key='generation'").run().changes;
for (let i = 0; i < 50; i++) { const r = await app.request('/health'); if (r.status !== 200) throw new Error('health ' + r.status); }
const after = statSync(path + '-wal').size;
console.log(JSON.stringify({ updateChanges: changes, walBefore: before, walAfter50Health: after, bytesPerHealth: (after - before) / 50 }));
db.close();
