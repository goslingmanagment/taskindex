// A-01 variant without HTTP reordering: the pending move is REJECTED (non-retryable), the editor already captured the optimistic revision.
import {
  openDatabase,
  migrate,
  generation,
  readState,
} from '/Users/dmitriy/code/taskindex/src/server/db.ts';
import { executeOperation } from '/Users/dmitriy/code/taskindex/src/server/operations.ts';
import { WorkspaceStore } from '/Users/dmitriy/code/taskindex/src/web/app/store.ts';
import { ApiError } from '/Users/dmitriy/code/taskindex/src/web/app/api.ts';
import { taskSaveCommand } from '/Users/dmitriy/code/taskindex/src/web/lib/use-workspace.ts';
import type {
  OperationEnvelope,
  Actor,
} from '/Users/dmitriy/code/taskindex/src/shared/model.ts';
const actor: Actor = { id: 'owner', label: 'O', kind: 'owner', scope: 'write' };
const db = openDatabase(':memory:');
migrate(db);
const gen = generation(db);
executeOperation(
  db,
  {
    operationId: 'c1',
    generation: gen,
    command: 'task.create',
    payload: { id: 't1', area: 'agency', title: 'T1' },
  },
  actor,
);
executeOperation(
  db,
  {
    operationId: 'c2',
    generation: gen,
    command: 'task.create',
    payload: { id: 't2', area: 'agency', title: 'T2', status: 'doing' },
  },
  actor,
);
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const store = new WorkspaceStore(
  async <T,>(_p: string, init?: RequestInit): Promise<T> => {
    const env = JSON.parse(String(init?.body)) as OperationEnvelope;
    if (env.operationId === 'move') await gate;
    const r = executeOperation(db, env, actor);
    if (!r.body.ok) throw new ApiError(r.body, r.status);
    return r.body as T;
  },
  undefined,
  async () => {},
);
const st = readState(db);
store.loadSnapshot({
  generation: gen,
  seq: 2,
  today: '2026-09-08',
  timezone: 'Europe/Moscow',
  tasks: st.tasks,
  projects: st.projects,
});
// owner drags t1 into 'doing' before t2; meanwhile (simulated) t2 got moved away so the neighbour is invalid -> server rejects with 'invalid' (non-retryable)
const move = store
  .submit(
    {
      command: 'task.move',
      payload: { id: 't1', baseRevision: 1, status: 'doing', before: 't2' },
    },
    'move',
  )
  .catch((e) => e);
const projected = store.getSnapshot().data.tasks.find((t) => t.id === 't1')!;
const editorSaved = structuredClone(projected); // editor.tsx:114-118 captures this as `saved`
console.log(
  '[a01] optimistic revision captured by editor:',
  editorSaved.revision,
  '| confirmed:',
  store.getSnapshot().confirmed.tasks.find((t) => t.id === 't1')!.revision,
);
executeOperation(
  db,
  {
    operationId: 'agent-move-t2',
    generation: gen,
    command: 'task.move',
    payload: { id: 't2', baseRevision: 1, status: 'todo' },
  },
  { id: 'agent:x', agentId: 'x', label: 'X', kind: 'agent', scope: 'tasks' },
);
release();
const moveResult = await move;
console.log(
  '[a01] move outcome:',
  moveResult instanceof ApiError ? moveResult.detail : 'ok',
);
// editor save (note) with the stale optimistic base, then a user "retry" with the same base
for (const attempt of [1, 2]) {
  try {
    await store.submit(
      taskSaveCommand({ ...editorSaved, note: 'note' }, editorSaved),
      `save-${attempt}`,
    );
    console.log(`[a01] save attempt ${attempt}: ok`);
  } catch (e) {
    console.log(
      `[a01] save attempt ${attempt}:`,
      (e as ApiError).detail?.code,
      (e as ApiError).detail?.message,
    );
  }
}
console.log(
  '[a01] server revision of t1 now:',
  readState(db).tasks.find((t) => t.id === 't1')!.revision,
  '| editor base still:',
  editorSaved.revision,
);
db.close();
