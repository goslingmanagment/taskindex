// R1: per-command cost grows with total event count (readState + readEvents(all) per command)
import { fixture, success } from '/Users/dmitriy/code/taskindex/tests/api/helpers.ts';
const f = fixture();
const origInfo = console.info; console.info = () => {}; // silence request log
const time = async (label: string, fn: () => Promise<unknown>, n = 10) => { const t0 = performance.now(); for (let i = 0; i < n; i++) await fn(); return `${label}: ${((performance.now() - t0) / n).toFixed(1)} ms/op`; };
const ids: string[] = [];
console.log(await time('task.create @ ~0 events', async () => { const r = success(await f.post({ command: 'task.create', payload: { area: 'agency', title: 'T' } })); ids.push((r.results[0].record as any).id); }));
for (let i = 0; i < 2000; i++) { const r = success(await f.post({ command: 'task.create', payload: { area: ['agency','development','personal'][i%3] as any, title: 'T' + i, note: 'x'.repeat(200) } })); ids.push((r.results[0].record as any).id); }
for (let i = 0; i < 2000; i++) { const t = f.state().tasks.find((t) => t.id === ids[i])!; success(await f.post({ command: 'task.update', payload: { id: t.id, baseRevision: t.revision, title: 'U' + i } })); }
const events = f.db.sqlite.prepare('select count(*) n from events').get() as any; const ops = f.db.sqlite.prepare('select count(*) n from operations').get() as any;
console.log('events:', events.n, 'operations:', ops.n, 'tasks:', f.state().tasks.length);
console.log(await time('task.create @ 4k events', async () => success(await f.post({ command: 'task.create', payload: { area: 'agency', title: 'T' } }))));
console.log(await time('task.update @ 4k events', async () => { const t = f.state().tasks[5]!; success(await f.post({ command: 'task.update', payload: { id: t.id, baseRevision: t.revision, focus: !t.focus } })); }));
const get = async (p: string) => { const r = await f.app.request(p, { headers: { 'x-test-role': 'owner' } }); if (r.status !== 200) throw new Error(p + ' ' + r.status); return r.json(); };
console.log(await time('GET /api/operations?limit=50', () => get('/api/operations?limit=50'), 5));
console.log(await time('GET /api/operations/{id} (single)', () => get('/api/operations/' + (f.db.sqlite.prepare('select id from operations limit 1').get() as any).id), 5));
console.log(await time('GET /api/tasks/{id}/history', () => get('/api/tasks/' + ids[0] + '/history'), 5));
console.log(await time('GET /api/digest', () => get('/api/digest'), 3));
console.log(await time('GET /api/snapshot', () => get('/api/snapshot'), 5));
console.log(await time('GET /api/tasks/{id}', () => get('/api/tasks/' + ids[0]), 5));
f.close();
