import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import {
  openDatabase,
  migrate,
} from '/Users/dmitriy/code/taskindex/src/server/db';
import { createAuth } from '/Users/dmitriy/code/taskindex/src/server/auth';
import { createOwner } from '/Users/dmitriy/code/taskindex/src/server/admin';
import { createApp } from '/Users/dmitriy/code/taskindex/src/server/app';
// This fixture is a separate real SQLite database and uses real owner auth.
const dir = mkdtempSync(join(tmpdir(), 'taskindex-e2e-'));
const db = openDatabase(join(dir, 'workspace.db'));
migrate(db);
await createOwner(db, {
  email: 'owner@example.test',
  password: 'TaskIndex-e2e-password-2026',
  name: 'Дмитрий',
});
const origin = 'http://localhost:4198';
const auth = createAuth(db, {
  baseURL: origin,
  secret: 'taskindex-isolated-e2e-secret-at-least-32-characters',
  trustedOrigins: [origin],
});
const app = createApp({
  db,
  auth,
  baseURL: origin,
  trustedOrigins: [origin],
  build: 'isolated-e2e',
});
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4018 });
const vite = await createServer({
  configFile: 'vite.config.ts',
  server: {
    host: '127.0.0.1',
    hmr: false,
    watch: null,
    port: 4198,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4018', changeOrigin: true } },
  },
});
await vite.listen();
console.log(`E2E fixture ready at ${origin}; isolated database ${dir}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  app.closeStreams();
  server.close();
  await vite.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
