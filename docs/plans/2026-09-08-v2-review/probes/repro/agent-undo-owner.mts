// R2: can an agent (tasks scope) undo an OWNER operation? R3: can sync set focus on untouched task?
import { fixture, success } from '/Users/dmitriy/code/taskindex/tests/api/helpers.ts';
import { focusGroups } from '/Users/dmitriy/code/taskindex/src/shared/queries.ts';
const f = fixture();
const created = success(await f.post({ command: 'task.create', payload: { area: 'agency', title: 'Владелец создал' } }));
const task = created.results[0].record as any;
const archived = await f.post({ command: 'task.archive', payload: { id: task.id, baseRevision: task.revision } });
const archOp = success(archived);
const undo = await f.post({ command: 'undo', payload: { operationId: archOp.operationId } }, { role: 'tasks' });
console.log('agent(tasks) undo of owner archive ->', undo.status, JSON.stringify({ ok: undo.body.ok, code: (undo.body as any).code }));
const after = f.state().tasks.find((t) => t.id === task.id)!;
console.log('task archived after agent undo:', after.archived, 'ownerFields:', JSON.stringify(after.ownerFields), 'ownerTouchedAt:', after.ownerTouchedAt);
// R3
const synced = success(await f.post({ command: 'task.sync', payload: { origin: { system: 'jira', ref: 'X-1', version: '1' }, fields: { area: 'agency', title: 'От агента', focus: true } } }, { role: 'agent' }));
const t2 = synced.results[0].record as any;
const groups = focusGroups(f.state().tasks, '2026-09-08');
console.log('agent-synced focus:true task lands in group:', groups.find((g) => g.tasks.some((t) => t.id === t2.id))?.id, '| createdBy', t2.createdBy, 'ownerTouchedAt', t2.ownerTouchedAt);
// R3b: agent can also flip focus via task.update on an untouched task
const upd = await f.post({ command: 'task.update', payload: { id: task.id, baseRevision: after.revision, focus: true } }, { role: 'tasks' });
console.log('agent task.update focus:true ->', upd.status, (upd.body as any).ok);
f.close();
