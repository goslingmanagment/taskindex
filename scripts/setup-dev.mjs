import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = new URL('../.env', import.meta.url);
if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    [
      'DATABASE_PATH=./data/dev.db',
      'BASE_URL=http://localhost:5173',
      'PORT=3001',
      'TIMEZONE=Europe/Moscow',
      `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  process.stdout.write('Создан локальный .env с отдельным секретом.\n');
} else {
  process.stdout.write('Используется существующий .env.\n');
}
const result = spawnSync(
  process.execPath,
  ['--env-file=.env', '--import', 'tsx', 'src/cli/admin.ts', 'migrate'],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
