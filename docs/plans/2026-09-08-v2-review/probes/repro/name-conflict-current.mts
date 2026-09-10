// assertInvariants duplicate project name: which record is reported as `current`?
import {
  fixture,
  success,
} from '/Users/dmitriy/code/taskindex/tests/api/helpers.ts';
console.info = () => {};
const f = fixture();
const first = success(
  await f.post({
    command: 'project.create',
    payload: {
      id: 'p-first',
      area: 'agency',
      name: 'Маркетинг',
      color: '#112233',
    },
  }),
);
const dup = await f.post({
  command: 'project.create',
  payload: {
    id: 'p-second',
    area: 'agency',
    name: '  маркетинг ',
    color: '#445566',
  },
});
console.log(
  'status',
  dup.status,
  'code',
  (dup.body as any).code,
  'current.id =',
  (dup.body as any).current?.id,
  '(existing is p-first)',
);
// /api/events poll: since > latestSeq accepted silently
const r = await f.app.request(
  '/api/events?generation=' + (first as any).generation + '&since=999999',
  { headers: { 'x-test-role': 'owner' } },
);
console.log(
  '/api/events since>latest ->',
  r.status,
  JSON.stringify(await r.json()),
);
f.close();
