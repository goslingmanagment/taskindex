// @ts-check
// Drill: после восстановления новая реплика несёт новое generation и одну новую задачу.
//   node /drill/verify-new-replica.mjs /data/backups/reference.json /data/backups/new-replica.json
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  process.stderr.write('verify-new-replica.mjs: BEFORE AFTER are required\n');
  process.exit(2);
}
/** @typedef {{ generation: string, seq: number, tasks: unknown[] }} Export */
const before = /** @type {Export} */ (
  JSON.parse(readFileSync(beforePath, 'utf8'))
);
const after = /** @type {Export} */ (
  JSON.parse(readFileSync(afterPath, 'utf8'))
);
if (
  before.generation === after.generation ||
  after.tasks.length !== before.tasks.length + 1
)
  throw new Error(
    'Replication after restore lost the new generation or command',
  );
console.log(
  JSON.stringify({
    ok: true,
    stage: 'new-replica-verified',
    generation: after.generation,
    seq: after.seq,
  }),
);
