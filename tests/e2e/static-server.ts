import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { openDatabase, migrate } from '../../src/server/db';
import { createOwner } from '../../src/server/admin';
// TI-069: the `static` Playwright project runs the production bundle (`vite build`)
// through the real server entry `src/server/index.ts`, not the Vite dev server.
const dir = mkdtempSync(join(tmpdir(), 'taskindex-e2e-static-'));
const webDir = join(dir, 'web');
await build({
  configFile: 'vite.config.ts',
  logLevel: 'warn',
  build: { outDir: webDir, emptyOutDir: true },
});
const db = openDatabase(join(dir, 'workspace.db'));
migrate(db);
await createOwner(db, {
  email: 'owner@example.test',
  password: 'TaskIndex-e2e-password-2026',
  name: 'Дмитрий',
});
db.close();
Object.assign(process.env, {
  NODE_ENV: 'development',
  HOST: 'localhost',
  PORT: '4373',
  BASE_URL: 'http://localhost:4373',
  BETTER_AUTH_SECRET: 'taskindex-isolated-e2e-static-secret-at-least-32-chars',
  DATABASE_PATH: join(dir, 'workspace.db'),
  TASKINDEX_WEB_DIR: webDir,
  TASKINDEX_WRITES: 'open',
  BUILD: 'isolated-e2e-static',
  LOG_LEVEL: 'warn',
});
await import('../../src/server/index');
console.log(
  `E2E static fixture ready at http://localhost:4373; bundle ${webDir}`,
);
