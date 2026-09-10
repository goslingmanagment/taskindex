import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { WorkspaceStore } from '../../../src/web/app/store.ts';
import { browserStorage, DraftStorage } from '../../../src/web/app/drafts.ts';
import { ApiError } from '../../../src/web/app/api.ts';

const snapshot = {
  generation: 'fixture-generation',
  seq: 0,
  tasks: [],
  projects: [],
  today: '2026-09-08',
  timezone: 'Europe/Moscow',
};
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() {
    throw new DOMException('Access denied', 'SecurityError');
  },
});
let postCount = 0;
try {
  assert.equal(browserStorage(), undefined);
  const store = new WorkspaceStore(
    async () => {
      postCount++;
      throw new ApiError({
        ok: false,
        code: 'unavailable',
        retryable: true,
        message: 'Lost response',
      });
    },
    browserStorage(),
    async () => {},
  );
  store.loadSnapshot(snapshot);
  await store
    .submit(
      {
        command: 'task.create',
        payload: {
          area: 'agency',
          title: 'Potentially committed without durable envelope',
        },
      },
      'missing-storage-operation',
    )
    .catch(() => {});
  const beforeReloadPending = store.getSnapshot().pending.length;
  const reloaded = new WorkspaceStore(
    async () => {
      throw new Error('Should have no operation to recover');
    },
    browserStorage(),
    async () => {},
  );
  reloaded.loadSnapshot(snapshot);
  await reloaded.recover();
  const afterReloadPending = reloaded.getSnapshot().pending.length;
  assert.equal(postCount, 4);
  assert.equal(beforeReloadPending, 1);
  assert.equal(afterReloadPending, 0);
  const draft = new DraftStorage(undefined, 'test');
  draft.write('task', {
    formatVersion: 1,
    generation: 'fixture-generation',
    baseRevision: 1,
    fields: { text: 'Unsaved text' },
  });
  assert(draft.read('task'));
  assert.equal(new DraftStorage(undefined, 'test').read('task'), null);
  const result = {
    runtime: process.version,
    storageGetter: 'SecurityError',
    resolvedStorage: 'undefined',
    postCount,
    beforeReloadPending,
    afterReloadPending,
    draftPersistedAcrossInstance: false,
  };
  console.log(JSON.stringify(result));
  await writeFile(
    new URL('./03-storage-probe-result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
} finally {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}
