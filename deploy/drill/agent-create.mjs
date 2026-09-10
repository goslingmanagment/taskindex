// @ts-check
// Drill: одна команда настоящего CLI через agent-ключ из volume.
//   dc run --rm --no-deps -T -v "$repo/deploy/drill:/drill:ro" app node /drill/agent-create.mjs OPERATION_ID [TITLE]
// Сервер берётся из TASKINDEX_URL (по умолчанию http://app:3000 — сеть compose).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [operationId, title = 'Проверка резервной копии'] = process.argv.slice(2);
if (!operationId) {
  process.stderr.write('agent-create.mjs: OPERATION_ID is required\n');
  process.exit(2);
}
const keyFile = process.env.DRILL_KEY_FILE ?? '/data/drill-key.json';
const token = /** @type {{ key: string }} */ (
  JSON.parse(readFileSync(keyFile, 'utf8'))
).key;
const child = spawnSync(
  process.execPath,
  [
    '/app/dist/cli/index.js',
    'task',
    'create',
    '--area',
    'agency',
    '--title',
    title,
    '--operation-id',
    operationId,
  ],
  {
    env: {
      ...process.env,
      TASKINDEX_URL: process.env.TASKINDEX_URL ?? 'http://app:3000',
      TASKINDEX_TOKEN: token,
      XDG_STATE_HOME: '/data/cli-state',
    },
    stdio: 'inherit',
  },
);
process.exit(child.status ?? 1);
