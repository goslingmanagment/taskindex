import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../../../tests/api/helpers.ts';

const f = fixture();
const projectCreation = await f.post({ command: 'project.create', payload: { id: 'none', area: 'agency', name: 'Allowed project ID', color: '#123456' } });
await f.post({ command: 'task.create', payload: { id: 'inside-project', projectId: 'none', area: 'agency', title: 'Task assigned to project none' } });
await f.post({ command: 'task.create', payload: { id: 'unassigned', area: 'agency', title: 'Unassigned task' } });
const filtered = await (await f.app.request('/api/tasks?project=none')).json();
assert.equal(projectCreation.status, 200);
assert.deepEqual(filtered.items.map((t: { id: string }) => t.id), ['unassigned']);

const taskCreation = await f.post({ command: 'task.create', payload: { id: 'by-origin', area: 'agency', title: 'Task with allowed ID by-origin' } });
const taskRead = await f.app.request('/api/tasks/by-origin');
assert.equal(taskCreation.status, 200);
assert.equal(taskRead.status, 400);
const results = {
  runtime: process.version,
  projectSentinel: { projectCreationStatus: projectCreation.status, requestedProjectId: 'none', expectedTaskIds: ['inside-project'], actualTaskIds: filtered.items.map((t: { id: string }) => t.id) },
  taskRoute: { taskCreationStatus: taskCreation.status, taskReadStatus: taskRead.status, body: await taskRead.json() },
};
console.log(JSON.stringify(results));
await writeFile(new URL('./03-id-probe-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
f.close();
