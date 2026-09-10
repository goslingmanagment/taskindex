// @ts-check
// Drill: экспорт восстановленной по TXID реплики совпадает с автономной копией.
//   node /drill/compare-exports.mjs /data/backups/reference.json /data/backups/restored.json
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const [referencePath, restoredPath] = process.argv.slice(2);
if (!referencePath || !restoredPath) {
  process.stderr.write(
    'compare-exports.mjs: REFERENCE RESTORED are required\n',
  );
  process.exit(2);
}
/** @param {string} path */
const load = (path) => {
  const data = /** @type {Record<string, unknown>} */ (
    JSON.parse(readFileSync(path, 'utf8'))
  );
  delete data.exportedAt;
  return data;
};
const reference = load(referencePath);
const restored = load(restoredPath);
if (!isDeepStrictEqual(reference, restored))
  throw new Error('Replicated restore differs from the offline checkpoint');
console.log(
  JSON.stringify({
    ok: true,
    stage: 'restored-export-equals-checkpoint',
    generation: reference.generation,
    seq: reference.seq,
  }),
);
