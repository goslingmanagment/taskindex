import { describe, expect, it } from 'vitest';
import { DraftStorage, type StorageLike } from '../../src/web/app/drafts';

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
