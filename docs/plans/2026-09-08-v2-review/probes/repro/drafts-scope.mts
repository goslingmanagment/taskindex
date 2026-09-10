// R8: without Web Locks, every page load creates a new draft scope and copies all drafts; old scopes never deleted
const mem = new Map<string, string>();
const fake = (m: Map<string, string>) => ({
  get length() {
    return m.size;
  },
  key: (i: number) => [...m.keys()][i] ?? null,
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
  clear: () => m.clear(),
});
(globalThis as any).localStorage = fake(mem);
const sess = new Map<string, string>();
(globalThis as any).sessionStorage = fake(sess);
Object.defineProperty(globalThis, 'navigator', {
  value: {},
  configurable: true,
});
console.log('navigator.locks present:', !!(globalThis as any).navigator?.locks);
for (let reload = 1; reload <= 5; reload++) {
  const m = await import(
    `/Users/dmitriy/code/taskindex/src/web/app/drafts.ts?reload=${reload}`
  );
  await m.initializeDrafts();
  if (reload === 1)
    for (let i = 0; i < 3; i++)
      m.writeDraft('task' + i, {
        formatVersion: 1,
        generation: 'g',
        baseRevision: 1,
        fields: { t: i },
      });
  const scopes = [...mem.keys()].filter((k) =>
    k.startsWith('taskindex/draft-scope/'),
  ).length;
  const draftKeys = [...mem.keys()].filter((k) =>
    k.startsWith('taskindex/drafts/'),
  ).length;
  console.log(
    `after load #${reload}: scopes=${scopes} draftKeys=${draftKeys} sessionScope=${sess.get('taskindex/draft-tab')?.slice(0, 8)}`,
  );
}
