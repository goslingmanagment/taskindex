// R7: a persisted outbox envelope from a previous generation stays pending forever
import { WorkspaceStore } from '/Users/dmitriy/code/taskindex/src/web/app/store.ts';
const mem = new Map<string, string>();
const storage = { get length() { return mem.size; }, key: (i: number) => [...mem.keys()][i] ?? null, getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
mem.set('taskindex/ops/op-old', JSON.stringify({ operationId: 'op-old', generation: 'OLD-GEN', command: 'task.create', payload: { area: 'agency', title: 'lost' } }));
const calls: string[] = [];
const transport = async <T,>(path: string): Promise<T> => { calls.push(path); if (path === '/api/snapshot') return { generation: 'NEW-GEN', seq: 0, today: '2026-09-08', timezone: 'Europe/Moscow', projects: [], tasks: [] } as T; throw new Error('unexpected ' + path); };
const store = new WorkspaceStore(transport, storage, async () => {});
await store.refresh();
const s = store.getSnapshot();
console.log('pending after refresh:', JSON.stringify(s.pending.map((p) => ({ id: p.envelope.operationId, gen: p.envelope.generation, status: p.status }))));
console.log('storage still has op:', mem.has('taskindex/ops/op-old'));
await store.retry('op-old').then(() => console.log('retry ok'), (e) => console.log('retry rejected:', e.message));
console.log('transport calls:', JSON.stringify(calls));
// second reload -> still there
const store2 = new WorkspaceStore(transport, storage, async () => {});
await store2.refresh();
console.log('pending after 2nd reload:', store2.getSnapshot().pending.length, '| any API to dismiss? finish is private:', typeof (store2 as any).finish);
