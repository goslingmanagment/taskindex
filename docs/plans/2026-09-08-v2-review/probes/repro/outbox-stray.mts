// R10: a stray file in the outbox dir breaks every CLI invocation
import { Outbox } from '/Users/dmitriy/code/taskindex/src/cli/outbox.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
const home =
  '/private/tmp/claude-501/-Users-dmitriy-code-taskindex/c5cd56f9-7e33-4f1e-8f89-5a82fb964e56/scratchpad/repro/xdg';
mkdirSync(home + '/taskindex/ops', { recursive: true });
writeFileSync(home + '/taskindex/ops/bad name.json', '{}');
const ob = new Outbox({ XDG_STATE_HOME: home });
try {
  console.log('list ok', await ob.list('http://x'));
} catch (e) {
  console.log(
    'list threw:',
    (e as Error).constructor.name,
    (e as Error).message,
  );
}
writeFileSync(home + '/taskindex/ops/bad name.json', '{'); // corrupted content variant, valid-looking name
writeFileSync(home + '/taskindex/ops/goodname.json', '{not json');
try {
  console.log('list ok', await ob.list('http://x'));
} catch (e) {
  console.log(
    'list threw (corrupt json):',
    (e as Error).constructor.name,
    (e as Error).message,
  );
}
