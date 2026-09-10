import { Outbox } from '/Users/dmitriy/code/taskindex/src/cli/outbox.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
const home =
  '/private/tmp/claude-501/-Users-dmitriy-code-taskindex/c5cd56f9-7e33-4f1e-8f89-5a82fb964e56/scratchpad/repro/xdg2';
rmSync(home, { recursive: true, force: true });
mkdirSync(home + '/taskindex/ops', { recursive: true });
writeFileSync(home + '/taskindex/ops/goodname.json', '{not json');
const ob = new Outbox({ XDG_STATE_HOME: home });
try {
  console.log('list ok', await ob.list('http://x'));
} catch (e) {
  console.log(
    'list threw (corrupt json):',
    (e as Error).constructor.name,
    (e as Error).message,
  );
}
