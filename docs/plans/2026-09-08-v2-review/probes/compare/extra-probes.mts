import { fixture, success } from '/Users/dmitriy/code/taskindex/tests/api/helpers.ts';
import { WorkspaceStore } from '/Users/dmitriy/code/taskindex/src/web/app/store.ts';
import type { Snapshot } from '/Users/dmitriy/code/taskindex/src/shared/model.ts';
const out = (k: string, v: unknown) => console.log(`[extra] ${k}: ${JSON.stringify(v)}`);

// (a) their B-05 extended: duplicate step id within one task via checklist.add -> ZodError path?
{
  const f = fixture();
  const t = success(await f.post({ command: 'task.create', payload: { id: 't1', area: 'agency', title: 'T', checklist: [{ id: 'step-a', text: 'A', done: false }] } }));
  const dup = await f.post({ command: 'checklist.add', payload: { taskId: 't1', baseRevision: 1, id: 'step-a', text: 'dup' } }, { id: 'dup-step' });
  const get = await f.app.request('/api/operations/dup-step');
  const reuse = await f.post({ command: 'task.update', payload: { id: 't1', baseRevision: 1, title: 'reused id' } }, { id: 'dup-step' });
  out('dup-step-id: add status/body', { status: dup.status, body: dup.body });
  out('dup-step-id: operation get status', get.status);
  out('dup-step-id: same id reused by other command', { status: reuse.status, ok: reuse.body.ok });
  f.close();
}
// (b) their B-04: since vs until asymmetry for null-lastSeq operations
{
  const f = fixture();
  await f.post({ command: 'task.create', payload: { id: 'e', area: 'agency', title: 'I' } }, { id: 'initial' });
  await f.post({ command: 'task.update', payload: { id: 'e', baseRevision: 1, title: 'I' } }, { id: 'noop' });
  await f.post({ command: 'task.create', payload: { id: 'e', area: 'agency', title: 'X' } }, { id: 'rejected' });
  const ids = async (q: string) => ((await (await f.app.request(`/api/operations${q}`)).json()) as { items: { id: string }[] }).items.map((i) => i.id);
  out('operations (no filter)', await ids(''));
  out('operations?since=0', await ids('?since=0'));
  out('operations?until=1', await ids('?until=1'));
  out('operations?since=0&until=1', await ids('?since=0&until=1'));
  out('digest (default since)', ((await (await f.app.request('/api/digest')).json()) as any).operations.items.map((i: any) => i.id));
  f.close();
}
// (c) their B-02: does the store self-heal after the stale snapshot when the NEXT SSE event arrives?
{
  const f = fixture();
  const s0 = (await (await f.app.request('/api/snapshot')).json()) as Snapshot;
  let release!: (s: Snapshot) => void;
  const delayed = new Promise<Snapshot>((r) => (release = r));
  const requests: string[] = [];
  const store = new WorkspaceStore(async <T,>(path: string): Promise<T> => {
    requests.push(path);
    if (path === '/api/snapshot') return (await delayed) as T;
    return (await (await f.app.request(path)).json()) as T;
  }, undefined, async () => {});
  store.loadSnapshot(s0); store.setConnected(true);
  const refreshing = store.refresh();
  const c1 = success(await f.post({ command: 'task.create', payload: { id: 'live-1', title: 'live 1', area: 'agency' } }));
  store.ingest(c1.events);
  release(s0); await refreshing;
  out('B-02 after stale snapshot', { seq: store.getSnapshot().seq, tasks: store.getSnapshot().confirmed.tasks.length });
  // next live event (seq 2) arrives on the still-open stream
  const c2 = success(await f.post({ command: 'task.create', payload: { id: 'live-2', title: 'live 2', area: 'agency' } }));
  store.ingest(c2.events);
  await new Promise((r) => setTimeout(r, 50));
  out('B-02 after next SSE event (self-heal via catchUp?)', { seq: store.getSnapshot().seq, tasks: store.getSnapshot().confirmed.tasks.length, requests });
  f.close();
}
// (d) their B-07 scope: which task routes work for id 'by-origin'
{
  const f = fixture();
  await f.post({ command: 'task.create', payload: { id: 'by-origin', area: 'agency', title: 'BO' } });
  for (const p of ['/api/tasks/by-origin', '/api/tasks/by-origin/history', '/api/tasks/by-origin/comments', '/api/tasks?q=BO']) {
    const r = await f.app.request(p); const b = await r.json();
    out(`GET ${p}`, { status: r.status, sample: JSON.stringify(b).slice(0, 80) });
  }
  f.close();
}
