// review-5 A1: two agents, one XDG_STATE_HOME; B runs `operation resume` and sends A's envelope under B's key.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  generation,
  readState,
} from '/Users/dmitriy/code/taskindex/src/server/db.ts';
import { createApp } from '/Users/dmitriy/code/taskindex/src/server/app.ts';
import { runCli } from '/Users/dmitriy/code/taskindex/src/cli/run.ts';
import { Outbox } from '/Users/dmitriy/code/taskindex/src/cli/outbox.ts';
import type { Actor } from '/Users/dmitriy/code/taskindex/src/shared/model.ts';
const agents: Record<string, Actor> = {
  'Bearer key-A': {
    id: 'agent:claude',
    agentId: 'claude',
    label: 'Claude',
    kind: 'agent',
    scope: 'tasks',
  },
  'Bearer key-B': {
    id: 'agent:codex',
    agentId: 'codex',
    label: 'Codex',
    kind: 'agent',
    scope: 'tasks',
  },
};
const db = openDatabase(':memory:');
migrate(db);
const app = createApp({
  db,
  baseURL: 'https://taskindex.test',
  authorize: (r) => agents[r.headers.get('authorization') ?? ''] ?? null,
});
const xdg = mkdtempSync(join(tmpdir(), 'ti-shared-outbox-'));
const base = 'https://taskindex.test';
const fetchApp = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(url instanceof Request ? url.url : url.toString());
  return app.request(u.pathname + u.search, init);
}) as typeof fetch;
// Agent A: envelope saved in outbox but never delivered (network down)
const outbox = new Outbox({ XDG_STATE_HOME: xdg });
await outbox.put({
  formatVersion: 1,
  baseUrl: base,
  endpoint: '/api/commands',
  envelope: {
    operationId: 'a-op-1',
    generation: generation(db),
    command: 'task.create',
    payload: { area: 'agency', title: 'Задача агента A' },
  },
});
console.log(
  '[shared] outbox after A:',
  (await outbox.list(base)).map((o) => o.envelope.operationId),
);
// Agent B on the same machine: plain `context` prints A's pending id; `operation resume` (no id) resends it under B's key
const outB: string[] = [],
  errB: string[] = [];
const run = (argv: string[]) =>
  runCli(argv, {
    env: { TASKINDEX_URL: base, TASKINDEX_TOKEN: 'key-B', XDG_STATE_HOME: xdg },
    fetch: fetchApp,
    stdout: (l) => outB.push(l),
    stderr: (l) => errB.push(l),
    sleep: async () => {},
  });
const code = await run(['operation', 'resume']);
console.log(
  '[shared] B `operation resume` exit:',
  code,
  '| stderr:',
  errB.map((l) => l.slice(0, 120)),
);
console.log(
  '[shared] B stdout:',
  outB.map((l) => l.slice(0, 200)),
);
const task = readState(db).tasks[0];
console.log(
  '[shared] task createdBy:',
  task?.createdBy,
  '| outbox after B resume:',
  (await outbox.list(base)).map((o) => o.envelope.operationId),
);
const op = (await (
  await app.request('/api/operations/a-op-1', {
    headers: { authorization: 'Bearer key-B' },
  })
).json()) as any;
console.log('[shared] stored operation actorId:', op.actorId);
// And A later retries its own envelope: server says the id belongs to another actor
const outA: string[] = [];
const codeA = await runCli(['operation', 'resume', 'a-op-1'], {
  env: { TASKINDEX_URL: base, TASKINDEX_TOKEN: 'key-A', XDG_STATE_HOME: xdg },
  fetch: fetchApp,
  stdout: (l) => outA.push(l),
  stderr: () => {},
  sleep: async () => {},
});
console.log(
  '[shared] A resume of its own id afterwards: exit',
  codeA,
  outA.map((l) => l.slice(0, 160)),
);
app.closeStreams();
db.close();
