// Read-only product audit: uses a fresh in-memory DB and in-memory draft storage.
import assert from 'node:assert/strict';
import { openDatabase, migrate } from '../../../src/server/db.ts';
import { createApp } from '../../../src/server/app.ts';
import { DraftStorage } from '../../../src/web/app/drafts.ts';

const db = openDatabase(':memory:');
migrate(db);
const diagnostics: string[] = [];
const priorError = console.error;
console.error = (value: unknown) => diagnostics.push(String(value));
try {
  const app = createApp({
    db,
    authorize: () => ({
      id: 'owner',
      label: 'Audit fixture',
      kind: 'owner',
      scope: 'write',
    }),
    now: () => {
      throw new Error('AUDIT_ONLY_EXPECTED_DIAGNOSTIC');
    },
  });
  const response = await app.request('/api/snapshot');
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.deepEqual(
    diagnostics.map((s) => JSON.parse(s)),
    [{ code: 'internal', error: 'Error' }],
  );
  console.log(
    JSON.stringify({ probe: 'Q-02', http: response.status, body, diagnostics }),
  );
  app.closeStreams();
} finally {
  console.error = priorError;
  db.close();
}

const raw = JSON.stringify({
  formatVersion: 1,
  generation: 'g',
  baseRevision: 1,
  fields: null,
});
const entries = new Map([['taskindex/drafts/probe/task', raw]]);
const drafts = new DraftStorage(
  {
    get length() {
      return entries.size;
    },
    key: (i) => [...entries.keys()][i] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  },
  'probe',
);
const restored = drafts.read<{ title: string }>('task');
assert.notEqual(restored, null);
let renderAccessThrows = false;
try {
  void restored!.fields.title;
} catch {
  renderAccessThrows = true;
}
assert.equal(renderAccessThrows, true);
console.log(
  JSON.stringify({
    probe: 'Q-04',
    acceptedInvalidDraft: restored,
    renderAccessThrows,
    originalRetained: entries.has('taskindex/drafts/probe/task'),
  }),
);
