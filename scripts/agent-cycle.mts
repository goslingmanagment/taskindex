#!/usr/bin/env node
// Исполняемый агентский цикл поверх работающего sandbox (TASKINDEX_SANDBOX):
// два агента через настоящий CLI с общим XDG_STATE_HOME, владелец через
// Better Auth. Шаги по docs/acceptance/agent-cycle.md; вывод: JSON-строка на
// шаг {step, ok, operationIds, details} и итог {ok, passed, failed, manual}.
//
//   eval "$(npm run -s sandbox)" && npm run agent-cycle
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../src/cli/run.js';
import { Outbox } from '../src/cli/outbox.js';
import { statePaths } from '../src/cli/state.js';
import { openDatabase } from '../src/server/db.js';
import { markRestored } from '../src/server/admin.js';

interface Sandbox {
  url: string;
  directory: string;
  database: string;
  stateHome: string;
  owner: { email: string; file: string };
  agents: Record<string, { scope: string; file: string }>;
}
type Body = Record<string, unknown>;
interface Reply {
  code: number;
  body: Body;
}

const MANUAL = [3, 6];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const directory = process.env.TASKINDEX_SANDBOX;
if (!directory) {
  process.stderr.write(
    'Нужен работающий sandbox: eval "$(npm run -s sandbox)" перед npm run agent-cycle\n',
  );
  process.exit(2);
}
const sandbox = JSON.parse(
  await readFile(join(directory, 'sandbox.json'), 'utf8'),
) as Sandbox;
const owner = JSON.parse(await readFile(sandbox.owner.file, 'utf8')) as {
  email: string;
  password: string;
};

async function keyOf(agent: string): Promise<string> {
  const entry = sandbox.agents[agent];
  assert(entry, `в sandbox нет агента ${agent}`);
  return (JSON.parse(await readFile(entry.file, 'utf8')) as { key: string })
    .key;
}

function agentCli(token: string) {
  const env = {
    TASKINDEX_URL: sandbox.url,
    TASKINDEX_TOKEN: token,
    XDG_STATE_HOME: sandbox.stateHome,
  };
  return {
    env,
    async run(argv: string[]): Promise<Reply> {
      const output: string[] = [];
      const code = await runCli(argv, {
        env,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
      });
      const last = output.at(-1);
      return { code, body: last ? (JSON.parse(last) as Body) : {} };
    },
  };
}

const claude = agentCli(await keyOf('claude'));
const codex = agentCli(await keyOf('codex'));

const login = await fetch(`${sandbox.url}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: sandbox.url },
  body: JSON.stringify({ email: owner.email, password: owner.password }),
});
assert(login.status === 200, `вход владельца: HTTP ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert(cookie, 'вход владельца не вернул cookie');
const ownerHeaders = {
  'content-type': 'application/json',
  origin: sandbox.url,
  cookie,
};
async function ownerGeneration(): Promise<string> {
  const context = (await (
    await fetch(`${sandbox.url}/api/context`, { headers: ownerHeaders })
  ).json()) as { generation: string };
  return context.generation;
}
async function ownerCommand(
  operationId: string,
  command: string,
  payload: Body,
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${sandbox.url}/api/commands`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      operationId,
      generation: await ownerGeneration(),
      command,
      payload,
    }),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

const results: { step: number; ok: boolean }[] = [];
async function step(
  number: number,
  fn: () => Promise<{ operationIds: string[]; details: Body }>,
): Promise<void> {
  try {
    const { operationIds, details } = await fn();
    results.push({ step: number, ok: true });
    process.stdout.write(
      `${JSON.stringify({ step: number, ok: true, operationIds, details })}\n`,
    );
  } catch (error) {
    results.push({ step: number, ok: false });
    process.stdout.write(
      `${JSON.stringify({
        step: number,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

const suffix = Date.now().toString(36);
const origin = (ref: string, version?: string) =>
  JSON.stringify({
    system: 'agent-cycle',
    ref: `${ref}-${suffix}`,
    ...(version ? { version } : {}),
  });
const sync = (version: string, note: string, projectId = `cycle-${suffix}`) => [
  'task',
  'sync',
  '--origin',
  origin('thread', version),
  '--fields',
  JSON.stringify({
    area: 'agency',
    projectId,
    title: 'Проверить отчёт',
    status: 'doing',
    note,
  }),
];
const result0 = (reply: Reply) =>
  (reply.body.results as Body[] | undefined)?.[0];
let task: { id: string; revision: number } | undefined;

await step(1, async () => {
  assert((await claude.run(['context'])).code === 0, 'claude: context');
  assert((await codex.run(['digest'])).code === 0, 'codex: digest');
  const project = await claude.run([
    'project',
    'create',
    '--id',
    `cycle-${suffix}`,
    '--area',
    'agency',
    '--name',
    `Цикл агентов ${suffix}`,
    '--color',
    '#123456',
    '--operation-id',
    `cycle-project-${suffix}`,
  ]);
  assert(
    project.code === 0,
    `claude: project create → ${JSON.stringify(project.body)}`,
  );
  const context = await codex.run(['context']);
  assert(
    (context.body.projects as { id: string }[]).some(
      (p) => p.id === `cycle-${suffix}`,
    ),
    'codex не видит проект в context',
  );
  const created = await claude.run(sync('1', 'Первая версия'));
  assert(
    created.code === 0,
    `claude: sync 1 → ${JSON.stringify(created.body)}`,
  );
  const record = result0(created)?.record as {
    id: string;
    revision: number;
    createdBy: string;
  };
  assert(record.createdBy === 'agent:claude', `автор ${record.createdBy}`);
  task = { id: record.id, revision: record.revision };
  const repeated = await codex.run(sync('1', 'Повтор'));
  assert(repeated.code === 0, 'codex: sync 1');
  const repeatedResult = result0(repeated)!;
  assert(
    repeatedResult.skipped === 'all' && repeatedResult.reason === 'stale',
    `повтор той же версии: ${JSON.stringify(repeatedResult)}`,
  );
  const noVersion = [
    'task',
    'sync',
    '--origin',
    origin('no-version'),
    '--fields',
    JSON.stringify({ area: 'agency', title: 'Источник без версии' }),
  ];
  const first = await claude.run(noVersion);
  assert(
    first.code === 0 && first.body.firstSeq !== null,
    'первый sync без версии создаёт задачу',
  );
  const second = await codex.run(noVersion);
  assert(
    second.code === 0 &&
      result0(second)?.reason === 'freshness_unknown' &&
      second.body.firstSeq === null,
    `второй sync без версии: ${JSON.stringify(second.body)}`,
  );
  return {
    operationIds: [
      String(created.body.operationId),
      String(repeated.body.operationId),
    ],
    details: { taskId: task.id, project: `cycle-${suffix}` },
  };
});

await step(2, async () => {
  assert(task, 'шаг 1 не создал задачу');
  const ownerProject = await ownerCommand(
    `owner-project-${suffix}`,
    'project.create',
    {
      id: `owner-${suffix}`,
      area: 'agency',
      name: `Решения владельца ${suffix}`,
      color: '#654321',
    },
  );
  assert(
    ownerProject.status === 200,
    `владелец: project.create ${ownerProject.status}`,
  );
  const closed = await ownerCommand(`owner-closes-${suffix}`, 'task.save', {
    id: task.id,
    baseRevision: task.revision,
    fields: { projectId: `owner-${suffix}` },
    status: 'done',
  });
  assert(closed.status === 200, `владелец: task.save ${closed.status}`);
  const updated = await claude.run(sync('2', 'Вторая версия'));
  assert(updated.code === 0, 'claude: sync 2');
  const outcome = result0(updated)!;
  const record = outcome.record as {
    status: string;
    projectId: string;
    originVersion: string;
  };
  assert(
    record.status === 'done' &&
      record.projectId === `owner-${suffix}` &&
      record.originVersion === '2',
    `решения владельца не сохранены: ${JSON.stringify(record)}`,
  );
  const skipped = outcome.skipped as { field: string; reason: string }[];
  assert(
    skipped.some((s) => s.field === 'status' && s.reason === 'owner') &&
      skipped.some((s) => s.field === 'projectId' && s.reason === 'owner') &&
      (outcome.applied as string[]).includes('note'),
    `applied/skipped: ${JSON.stringify(outcome)}`,
  );
  const fresh = await claude.run(['task', 'get', task.id]);
  const revision = fresh.body.revision as number;
  const [commentA, commentB, ownerNote] = await Promise.all([
    claude.run(['comment', 'add', task.id, '--text', 'Отчёт агента claude']),
    codex.run(['comment', 'add', task.id, '--text', 'Отчёт агента codex']),
    ownerCommand(`owner-note-${suffix}`, 'task.save', {
      id: task.id,
      baseRevision: revision,
      fields: { note: 'Заметка владельца' },
    }),
  ]);
  assert(
    commentA.code === 0 && commentB.code === 0 && ownerNote.status === 200,
    'параллельные комментарии и заметка',
  );
  const final = await claude.run(['task', 'get', task.id]);
  assert(
    final.body.commentCount === 2 && final.body.note === 'Заметка владельца',
    `итог задачи: ${JSON.stringify(final.body)}`,
  );
  task = { id: task.id, revision: final.body.revision as number };
  return {
    operationIds: [
      String(updated.body.operationId),
      String(commentA.body.operationId),
      String(commentB.body.operationId),
    ],
    details: { commentCount: final.body.commentCount, note: final.body.note },
  };
});

await step(4, async () => {
  const file = join(sandbox.directory, `agent-cycle-batch-${suffix}.json`);
  await writeFile(
    file,
    JSON.stringify(
      [1, 2, 3].map((n) => ({
        command: 'task.create',
        payload: { area: 'agency', title: `Пакет ${n} ${suffix}` },
      })),
    ),
  );
  const batch = await claude.run([
    'batch',
    '--file',
    file,
    '--operation-id',
    `cycle-batch-${suffix}`,
  ]);
  assert(
    batch.code === 0 && (batch.body.events as unknown[]).length === 3,
    `batch: ${JSON.stringify(batch.body)}`,
  );
  const activity = await claude.run(['activity']);
  const row = (activity.body.items as { id: string; taskCount: number }[]).find(
    (i) => i.id === `cycle-batch-${suffix}`,
  );
  assert(
    row?.taskCount === 3,
    `активность не показывает пакет одной операцией: ${JSON.stringify(row)}`,
  );
  const undone = await ownerCommand(`owner-undo-batch-${suffix}`, 'undo', {
    operationId: `cycle-batch-${suffix}`,
  });
  assert(undone.status === 200, `владелец: undo пакета ${undone.status}`);
  const y = await claude.run([
    'task',
    'create',
    '--area',
    'agency',
    '--title',
    `Задача Y ${suffix}`,
    '--operation-id',
    `cycle-y-${suffix}`,
  ]);
  const yRecord = result0(y)?.record as { id: string; revision: number };
  const edited = await claude.run([
    'task',
    'update',
    yRecord.id,
    '--base-revision',
    String(yRecord.revision),
    '--title',
    `Задача Y, правка ${suffix}`,
  ]);
  assert(edited.code === 0, 'claude: update Y');
  const late = await ownerCommand(`owner-undo-y-${suffix}`, 'undo', {
    operationId: `cycle-y-${suffix}`,
  });
  assert(
    late.status === 409 && late.body.code === 'conflict',
    `undo после поздней правки: ${late.status} ${JSON.stringify(late.body)}`,
  );
  const rename = await ownerCommand(
    `owner-rename-${suffix}`,
    'project.update',
    {
      id: `owner-${suffix}`,
      baseRevision: 1,
      name: `Решения владельца, новое имя ${suffix}`,
    },
  );
  assert(rename.status === 200, `владелец: project.update ${rename.status}`);
  const forbidden = await codex.run([
    'undo',
    '--operation',
    `owner-rename-${suffix}`,
  ]);
  assert(
    forbidden.code === 4 && forbidden.body.code === 'forbidden',
    `ключ tasks отменил project.update: ${JSON.stringify(forbidden.body)}`,
  );
  return {
    operationIds: [
      `cycle-batch-${suffix}`,
      `owner-undo-batch-${suffix}`,
      `cycle-y-${suffix}`,
      `owner-undo-y-${suffix}`,
      `owner-rename-${suffix}`,
    ],
    details: {
      batchTasks: row.taskCount,
      lateUndo: late.body.code,
      foreignUndo: forbidden.body.code,
    },
  };
});

await step(7, async () => {
  // Only the mark-restored part is automated: an envelope saved under the old
  // generation is rejected with generation_changed and settled as definitive.
  const outbox = new Outbox(statePaths(claude.env, sandbox.url).ops('claude'));
  const stale = `cycle-stale-${suffix}`;
  await outbox.put({
    formatVersion: 2,
    baseUrl: sandbox.url,
    endpoint: '/api/commands',
    actorId: 'agent:claude',
    envelope: {
      operationId: stale,
      generation: await ownerGeneration(),
      command: 'task.create',
      payload: { area: 'agency', title: `Старый конверт ${suffix}` },
    },
  });
  const db = openDatabase(sandbox.database);
  try {
    markRestored(db);
  } finally {
    db.close();
  }
  const resumed = await claude.run(['operation', 'resume', stale]);
  assert(
    resumed.code === 3 && resumed.body.code === 'generation_changed',
    `resume старого конверта: ${JSON.stringify(resumed.body)}`,
  );
  const listed = await claude.run(['operation', 'list']);
  assert(
    (listed.body.pending as unknown[]).length === 0,
    'старый конверт остался в очереди',
  );
  return {
    operationIds: [stale],
    details: {
      code: resumed.body.code,
      partial: 'перезагрузка вкладки вручную',
    },
  };
});

const passed = results.filter((r) => r.ok).map((r) => r.step);
const failed = results.filter((r) => !r.ok).map((r) => r.step);
process.stdout.write(
  `${JSON.stringify({ ok: failed.length === 0, passed, failed, manual: MANUAL })}\n`,
);
process.exitCode = failed.length ? 1 : 0;
