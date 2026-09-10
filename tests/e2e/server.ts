import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import { openDatabase, migrate } from '../../src/server/db';
import { createAuth } from '../../src/server/auth';
import { createAgent, createOwner } from '../../src/server/admin';
import { hashAgentKey } from '../../src/server/agent-keys';
import * as schema from '../../src/server/schema';
import { AGENT } from './helpers';
import { createApp } from '../../src/server/app';
// This fixture is a separate real SQLite database and uses real owner auth.
// TI-070: ports, the fixture name and the frozen clock come from the
// environment, so `playwright.config.ts` can start one such server per project
// and no project ever sees another project's records.
const name = process.env.TASKINDEX_E2E_BASE ?? 'main';
const apiPort = Number(process.env.TASKINDEX_E2E_API_PORT ?? 4001);
const webPort = Number(process.env.TASKINDEX_E2E_WEB_PORT ?? 4173);
// An ISO instant here freezes every `createdAt` the domain writes, so scenes
// with a time label render the same on two runs in a row.
const frozen = process.env.TASKINDEX_E2E_NOW?.trim();
const dir = mkdtempSync(join(tmpdir(), `taskindex-e2e-${name}-`));
const db = openDatabase(join(dir, 'workspace.db'));
migrate(db);
await createOwner(db, {
  email: 'owner@example.test',
  password: 'TaskIndex-e2e-password-2026',
  name: 'Дмитрий',
});
// TI-076: a known agent with a fixed key, so a spec can act as a second author.
createAgent(db, { id: AGENT.id, label: AGENT.label });
db.orm
  .insert(schema.agentKeys)
  .values({
    id: 'e2e-agent-key',
    agentId: AGENT.id,
    scope: 'write',
    keyHash: hashAgentKey(AGENT.key),
    name: AGENT.label,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  })
  .run();
const origin = `http://localhost:${webPort}`;
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
  ...(frozen ? { now: () => frozen } : {}),
});
const server = serve({
  fetch: app.fetch,
  hostname: 'localhost',
  port: apiPort,
});
const vite = await createServer({
  configFile: 'vite.config.ts',
  // Own dependency cache: several fixtures run at once and must not optimize
  // into the same `node_modules/.vite`.
  cacheDir: join(dir, 'vite-cache'),
  server: {
    host: 'localhost',
    hmr: false,
    watch: null,
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
});
await vite.listen();
console.log(
  `E2E fixture «${name}» ready at ${origin}; isolated database ${dir}` +
    (frozen ? `; frozen clock ${frozen}` : ''),
);
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
