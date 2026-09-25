#!/usr/bin/env node
// Одноразовое dev-окружение одной командой: временная база в mkdtemp, владелец,
// два агента с ключами, сервер на свободном порту. Ничего не читает из .env и
// ничего не пишет в чекаут; ключи здесь тестовые и годятся только для этой базы.
//
//   eval "$(npm run -s sandbox)"          запуск; экспортирует TASKINDEX_URL,
//                                         TASKINDEX_TOKEN (агент claude, write),
//                                         XDG_STATE_HOME, TASKINDEX_SANDBOX
//   npm run -s sandbox -- --token codex   только строка export для другого агента
//   npm run sandbox -- --json             описание окружения JSON вместо export
//   npm run sandbox -- --stop [--keep]    остановить сервер и удалить каталог
//   --writes held --deployment ID         сценарий шага 6 агентского цикла
//   --agents claude:write,codex:tasks     набор агентов и прав (read, propose,
//                                         tasks, write)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/server/db.js';
import {
  createAgent,
  createAgentKey,
  createOwner,
  initialize,
} from '../src/server/admin.js';
import type { Scope } from '../src/shared/model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const PREFIX = 'taskindex-sandbox-';

interface Description {
  formatVersion: 1;
  pid: number;
  port: number;
  url: string;
  directory: string;
  database: string;
  stateHome: string;
  log: string;
  owner: { email: string; file: string };
  agents: Record<string, { scope: Scope; file: string }>;
  writes: 'held' | 'open';
  deployment: string;
  startedAt: string;
}

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--'))
      throw new Error(`Неизвестный аргумент: ${token}`);
    const [name, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) flags[name!] = inline;
    else if (['stop', 'keep', 'json', 'help'].includes(name!))
      flags[name!] = true;
    else {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`Нужно значение --${name}`);
      flags[name!] = value;
    }
  }
  return flags;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('порт'))));
    });
  });
}

async function latestSandbox(): Promise<string | undefined> {
  const entries = await readdir(tmpdir()).catch(() => [] as string[]);
  const candidates = await Promise.all(
    entries
      .filter((name) => name.startsWith(PREFIX))
      .map(async (name) => {
        const directory = join(tmpdir(), name);
        try {
          const info = await stat(join(directory, 'sandbox.json'));
          return { directory, mtime: info.mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );
  return candidates
    .filter((c): c is { directory: string; mtime: number } => !!c)
    .sort((a, b) => b.mtime - a.mtime)[0]?.directory;
}

async function describeExisting(
  env: NodeJS.ProcessEnv,
  flags: Record<string, string | true>,
): Promise<Description> {
  const directory =
    (typeof flags.dir === 'string' ? flags.dir : undefined) ??
    env.TASKINDEX_SANDBOX ??
    (await latestSandbox());
  if (!directory)
    throw new Error(
      'Sandbox не найден: задайте TASKINDEX_SANDBOX или --dir <каталог>',
    );
  return JSON.parse(
    await readFile(join(directory, 'sandbox.json'), 'utf8'),
  ) as Description;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop(
  env: NodeJS.ProcessEnv,
  flags: Record<string, string | true>,
): Promise<void> {
  const description = await describeExisting(env, flags);
  if (alive(description.pid)) {
    process.kill(description.pid, 'SIGTERM');
    const deadline = Date.now() + 10_000;
    while (alive(description.pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (alive(description.pid)) process.kill(description.pid, 'SIGKILL');
  }
  if (flags.keep) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, stopped: description.pid, kept: description.directory })}\n`,
    );
    return;
  }
  await rm(description.directory, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({ ok: true, stopped: description.pid, removed: description.directory })}\n`,
  );
}

async function token(
  env: NodeJS.ProcessEnv,
  flags: Record<string, string | true>,
): Promise<void> {
  const description = await describeExisting(env, flags);
  const agent = String(flags.token);
  const entry = description.agents[agent];
  if (!entry)
    throw new Error(
      `Агент ${agent} не входит в sandbox: ${Object.keys(description.agents).join(', ')}`,
    );
  const key = JSON.parse(await readFile(entry.file, 'utf8')) as { key: string };
  process.stdout.write(`export TASKINDEX_TOKEN=${shellQuote(key.key)}\n`);
}

function agentsFromFlag(value: string | true | undefined): [string, Scope][] {
  const spec = typeof value === 'string' ? value : 'claude:write,codex:tasks';
  return spec.split(',').map((item) => {
    const [id, scope] = item.split(':');
    if (!id || !['read', 'propose', 'tasks', 'write'].includes(scope ?? ''))
      throw new Error(`--agents: ожидается id:scope, получено "${item}"`);
    return [id, scope as Scope];
  });
}

async function start(flags: Record<string, string | true>): Promise<void> {
  const writes = flags.writes === 'held' ? 'held' : 'open';
  const deployment =
    typeof flags.deployment === 'string' ? flags.deployment : 'sandbox';
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  const stateHome = join(directory, 'state');
  const keys = join(directory, 'keys');
  await mkdir(stateHome, { mode: 0o700 });
  await mkdir(keys, { mode: 0o700 });
  const database = join(directory, 'sandbox.db');
  const db = openDatabase(database);
  const ownerPassword = randomBytes(18).toString('base64url');
  const ownerFile = join(directory, 'owner.json');
  const agents: Description['agents'] = {};
  const tokens: Record<string, string> = {};
  try {
    initialize(db, { timezone: 'Europe/Moscow' });
    const owner = await createOwner(db, {
      email: 'owner@sandbox.test',
      password: ownerPassword,
      name: 'Владелец sandbox',
    });
    await writeFile(
      ownerFile,
      `${JSON.stringify({ email: owner.email, password: ownerPassword })}\n`,
      { mode: 0o600 },
    );
    for (const [id, scope] of agentsFromFlag(flags.agents)) {
      createAgent(db, { id, label: `${id}, sandbox` });
      const key = createAgentKey(db, { agentId: id, scope });
      const file = join(keys, `${id}.json`);
      await writeFile(file, `${JSON.stringify(key)}\n`, { mode: 0o600 });
      agents[id] = { scope, file };
      tokens[id] = key.key;
    }
  } finally {
    db.close();
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = join(directory, 'server.log');
  const logFile = await open(log, 'a', 0o600);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment))
    if (
      name.startsWith('TASKINDEX_') ||
      [
        'DATABASE_PATH',
        'BASE_URL',
        'PORT',
        'BETTER_AUTH_SECRET',
        'NODE_ENV',
        'BUILD',
        'BUILD_ID',
      ].includes(name)
    )
      delete environment[name];
  Object.assign(environment, {
    PORT: String(port),
    BASE_URL: url,
    DATABASE_PATH: database,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    BUILD: 'sandbox',
    TASKINDEX_WRITES: writes,
    TASKINDEX_DEPLOYMENT: deployment,
  });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server/index.ts'],
    {
      cwd: root,
      env: environment,
      detached: true,
      stdio: ['ignore', logFile.fd, logFile.fd],
    },
  );
  child.unref();
  await logFile.close();
  const description: Description = {
    formatVersion: 1,
    pid: child.pid!,
    port,
    url,
    directory,
    database,
    stateHome,
    log,
    owner: { email: 'owner@sandbox.test', file: ownerFile },
    agents,
    writes,
    deployment,
    startedAt: new Date().toISOString(),
  };
  await writeFile(
    join(directory, 'sandbox.json'),
    `${JSON.stringify(description, null, 2)}\n`,
    { mode: 0o600 },
  );
  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    if (!alive(child.pid!)) break;
    try {
      const response = await fetch(`${url}/health`);
      const body = (await response.json()) as { ok?: boolean };
      healthy = body.ok === true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  if (!healthy) {
    process.stderr.write(await readFile(log, 'utf8').catch(() => ''));
    if (alive(child.pid!)) process.kill(child.pid!, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
    throw new Error('Сервер sandbox не ответил на /health за 15 с');
  }
  const [firstAgent] = Object.keys(agents);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...description, tokens })}\n`);
    return;
  }
  process.stdout.write(
    [
      `export TASKINDEX_URL=${shellQuote(url)}`,
      `export TASKINDEX_TOKEN=${shellQuote(tokens[firstAgent!]!)}`,
      `export XDG_STATE_HOME=${shellQuote(stateHome)}`,
      `export TASKINDEX_SANDBOX=${shellQuote(directory)}`,
      '',
    ].join('\n'),
  );
}

try {
  const flags = parse(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(
      'sandbox [--json] [--writes held|open] [--deployment ID] [--agents id:scope,...] | --token AGENT | --stop [--keep] [--dir DIR]\n',
    );
  } else if (flags.stop) await stop(process.env, flags);
  else if (flags.token !== undefined) await token(process.env, flags);
  else await start(flags);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, code: 'sandbox_error', message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
