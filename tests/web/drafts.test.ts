import { describe, expect, it } from 'vitest';
import {
  DraftStorage,
  DRAFT_SCOPE_TTL_MS,
  chooseScope,
  type StorageLike,
} from '../../src/web/app/drafts';

class MemoryStorage implements StorageLike {
  entries = new Map<string, string>();
  get length() {
    return this.entries.size;
  }
  key(index: number) {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
}
const draft = (title: string) => ({
  formatVersion: 1 as const,
  generation: 'g1',
  baseRevision: 2,
  fields: { title },
  operationId: 'unconfirmed-operation',
});
describe('draft ownership', () => {
  it('saving another tab never deletes this tab’s text, including after reload', () => {
    const storage = new MemoryStorage();
    const first = new DraftStorage(storage, 'tab-a');
    const second = new DraftStorage(storage, 'tab-b');
    first.write('task', draft('First tab'));
    second.write('task', draft('Second tab'));
    second.clear('task');
    expect(new DraftStorage(storage, 'tab-a').read('task')).toEqual(
      draft('First tab'),
    );
    expect(new DraftStorage(storage, 'tab-b').read('task')).toBeNull();
  });
  it('both creation forms receive consumption of the same draft', () => {
    const storage = new MemoryStorage();
    const drafts = new DraftStorage(storage, 'tab');
    const seen: unknown[] = [];
    const unsubscribe = drafts.subscribe('new/agency/all/todo', () =>
      seen.push(drafts.read('new/agency/all/todo')),
    );
    drafts.write('new/agency/all/todo', draft('Create once'));
    drafts.clear('new/agency/all/todo');
    expect(seen).toEqual([draft('Create once'), null]);
    expect(storage.getItem('taskindex/draft-scope/tab')).toBeNull();
    unsubscribe();
  });
  it('a failed storage write does not erase the text of a subscribed form', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('quota');
    };
    const drafts = new DraftStorage(storage, 'tab');
    let text: unknown;
    drafts.subscribe('task', () => {
      text = drafts.read('task');
    });
    drafts.write('task', draft('Keep typing'));
    expect(text).toEqual(draft('Keep typing'));
  });
  it('the legacy scope can restore and consume drafts written before tab isolation', () => {
    const storage = new MemoryStorage();
    storage.setItem('taskindex/draft/task', JSON.stringify(draft('Old draft')));
    const drafts = new DraftStorage(storage, 'legacy');
    expect(drafts.read('task')).toEqual(draft('Old draft'));
    new DraftStorage(storage, 'another-tab').clear('task');
    expect(drafts.read('task')).toEqual(draft('Old draft'));
    drafts.clear('task');
    expect(storage.getItem('taskindex/draft/task')).toBeNull();
  });
});

const DAY = 24 * 60 * 60 * 1000;
const keys = (storage: MemoryStorage, prefix: string) =>
  [...storage.entries.keys()].filter((key) => key.startsWith(prefix));
// A LockManager whose locks are always free except the listed names.
const fakeLocks = (held: string[] = []) =>
  ({
    request: async (
      name: string,
      _options: unknown,
      callback: (lock: { name: string } | null) => Promise<unknown>,
    ) => callback(held.includes(name) ? null : { name }),
  }) as unknown as LockManager;
describe('TI-041 draft scope without Web Locks', () => {
  it('reuses the scope of this tab on every reload instead of cloning it', async () => {
    // Fable repro drafts-scope: scopes 1,2,3,4,5 and draftKeys 3,6,9,12,15 before the fix.
    const storage = new MemoryStorage();
    const session = new MemoryStorage();
    let scope = '';
    for (let reload = 1; reload <= 5; reload++) {
      const chosen = await chooseScope({ storage, session, now: () => 1000 });
      if (reload === 1) {
        scope = chosen.scope;
        const drafts = new DraftStorage(storage, chosen.scope);
        for (let i = 0; i < 3; i++)
          drafts.write(`task${i}`, draft(`Text ${i}`));
      }
      expect(chosen.scope).toBe(scope);
      expect(keys(storage, 'taskindex/draft-scope/')).toHaveLength(1);
      expect(keys(storage, 'taskindex/drafts/')).toHaveLength(3);
    }
  });
  it('a new tab without a session copies the freshest scope and removes only expired ones', async () => {
    const storage = new MemoryStorage();
    const now = 100 * DAY;
    new DraftStorage(storage, 'fresh').write('task', draft('Fresh'));
    storage.setItem('taskindex/draft-scope/fresh', String(now - DAY));
    new DraftStorage(storage, 'stale').write('task', draft('Stale'));
    storage.setItem(
      'taskindex/draft-scope/stale',
      String(now - DRAFT_SCOPE_TTL_MS - DAY),
    );
    storage.setItem('taskindex/draft/task', JSON.stringify(draft('Legacy')));
    const chosen = await chooseScope({
      storage,
      session: new MemoryStorage(),
      now: () => now,
    });
    expect(chosen.removed).toEqual(['stale']);
    expect(new DraftStorage(storage, chosen.scope).read('task')).toEqual(
      draft('Fresh'),
    );
    expect(new DraftStorage(storage, 'fresh').read('task')).toEqual(
      draft('Fresh'),
    );
    expect(new DraftStorage(storage, 'stale').read('task')).toBeNull();
    expect(storage.getItem('taskindex/draft-scope/stale')).toBeNull();
    expect(new DraftStorage(storage, 'legacy').read('task')).toEqual(
      draft('Legacy'),
    );
  });
});
describe('TI-041 draft scope garbage collection with Web Locks', () => {
  it('removes an expired unheld scope, keeps recent and held ones and legacy', async () => {
    const storage = new MemoryStorage();
    const now = 100 * DAY;
    for (const [scope, age] of [
      ['expired', DRAFT_SCOPE_TTL_MS + DAY],
      ['recent', DAY],
      ['expired-held', DRAFT_SCOPE_TTL_MS + DAY],
    ] as const) {
      new DraftStorage(storage, scope).write('task', draft(scope));
      storage.setItem(`taskindex/draft-scope/${scope}`, String(now - age));
    }
    storage.setItem('taskindex/draft/task', JSON.stringify(draft('Legacy')));
    const chosen = await chooseScope({
      storage,
      session: new MemoryStorage(),
      locks: fakeLocks(['taskindex/draft-writer/expired-held']),
      now: () => now,
    });
    expect(chosen.removed).toEqual(['expired']);
    expect(new DraftStorage(storage, 'recent').read('task')).toEqual(
      draft('recent'),
    );
    expect(new DraftStorage(storage, 'expired-held').read('task')).toEqual(
      draft('expired-held'),
    );
    expect(new DraftStorage(storage, 'expired').read('task')).toBeNull();
    expect(new DraftStorage(storage, 'legacy').read('task')).toEqual(
      draft('Legacy'),
    );
  });
  it('a duplicated tab whose scope is held gets an independent copy', async () => {
    const storage = new MemoryStorage();
    const session = new MemoryStorage();
    session.setItem('taskindex/draft-tab', 'original');
    new DraftStorage(storage, 'original').write('task', draft('Shared text'));
    storage.setItem('taskindex/draft-scope/original', '1000');
    const chosen = await chooseScope({
      storage,
      session,
      locks: fakeLocks(['taskindex/draft-writer/original']),
      now: () => 2000,
    });
    expect(chosen.scope).not.toBe('original');
    expect(chosen.removed).toEqual([]);
    expect(new DraftStorage(storage, chosen.scope).read('task')).toEqual(
      draft('Shared text'),
    );
    new DraftStorage(storage, chosen.scope).clear('task');
    expect(new DraftStorage(storage, 'original').read('task')).toEqual(
      draft('Shared text'),
    );
    expect(session.getItem('taskindex/draft-tab')).toBe(chosen.scope);
  });
});
