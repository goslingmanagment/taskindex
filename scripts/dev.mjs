import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(new URL('../.env', import.meta.url)))
  loadEnvFile(new URL('../.env', import.meta.url));
const environment = {
  ...process.env,
  PORT: process.env.PORT ?? '3001',
  BASE_URL: process.env.BASE_URL ?? 'http://localhost:5173',
  DATABASE_PATH: process.env.DATABASE_PATH ?? './data/dev.db',
};
const children = [
  spawn(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--watch',
      '--import',
      'tsx',
      'src/server/index.ts',
    ],
    { cwd: root, env: environment, stdio: 'inherit' },
  ),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 5000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) {
  child.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    stop(1);
  });
  child.on('exit', (code) => stop(code ?? 1));
}
