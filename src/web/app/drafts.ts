export interface StorageLike {
  length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
export type Draft<T> = {
  formatVersion: 1;
  generation: string;
  baseRevision: number;
  fields: T;
  id?: string;
  operationId?: string;
};
const scopePrefix = 'taskindex/draft-scope/';
const tabKey = 'taskindex/draft-tab';
const prefix = (scope: string) =>
  scope === 'legacy' ? 'taskindex/draft/' : `taskindex/drafts/${scope}/`;
export class DraftStorage {
  private listeners = new Map<string, Set<() => void>>();
  private values = new Map<string, Draft<unknown> | null>();
  constructor(
    private storage: StorageLike | undefined,
    readonly scope: string,
  ) {}
  read<T>(id: string): Draft<T> | null {
    if (this.values.has(id)) return this.values.get(id) as Draft<T> | null;
    try {
      const raw = this.storage?.getItem(`${prefix(this.scope)}${id}`);
      const draft = raw ? JSON.parse(raw) : null;
      return draft?.formatVersion === 1 ? draft : null;
    } catch {
      return null;
    }
  }
  write<T>(id: string, draft: Draft<T>) {
    this.values.set(id, draft);
    try {
      this.storage?.setItem(
        `${prefix(this.scope)}${id}`,
        JSON.stringify(draft),
      );
      this.storage?.setItem(`${scopePrefix}${this.scope}`, String(Date.now()));
    } catch {
      /* The editor remains usable when storage is full. */
    }
    this.notify(id);
  }
  clear(id: string) {
    this.values.set(id, null);
    try {
      this.storage?.removeItem(`${prefix(this.scope)}${id}`);
      let hasDrafts = false;
      for (let i = 0; i < (this.storage?.length ?? 0); i++)
        if (this.storage!.key(i)?.startsWith(prefix(this.scope))) {
          hasDrafts = true;
          break;
        }
      if (!hasDrafts) this.storage?.removeItem(`${scopePrefix}${this.scope}`);
    } catch {
      /* Storage may be unavailable. */
    }
    this.notify(id);
  }
  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  private notify(id: string) {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
}
// A scope survives reloads in sessionStorage; its data remains in localStorage.
// The lifetime lock prevents duplicated tabs (which clone sessionStorage) from
// sharing a writer. New tabs can reclaim an inactive scope after it was closed.
let drafts = new DraftStorage(browserStorage(), crypto.randomUUID());
let initialization: Promise<void> | undefined;
export function initializeDrafts(): Promise<void> {
  return (initialization ??= initialize());
}
async function initialize() {
  const storage = browserStorage();
  let previous: string | null = null;
  const candidates: { scope: string; at: number }[] = [];
  try {
    previous = sessionStorage.getItem(tabKey);
  } catch {
    /* Persistent drafts can still be recovered without sessionStorage. */
  }
  try {
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const key = storage!.key(i)!;
      if (key.startsWith(scopePrefix))
        candidates.push({
          scope: key.slice(scopePrefix.length),
          at: Number(storage!.getItem(key)) || 0,
        });
      else if (key.startsWith(prefix('legacy')))
        candidates.push({ scope: 'legacy', at: 0 });
      else if (key.startsWith('taskindex/drafts/')) {
        const scope = key.slice('taskindex/drafts/'.length).split('/')[0];
        if (scope) candidates.push({ scope, at: 0 });
      }
    }
  } catch {
    /* Storage access can be disabled by the browser. */
  }
  const claim = (scope: string) =>
    new Promise<boolean>((resolve) => {
      if (!navigator.locks) return resolve(false);
      void navigator.locks
        .request(
          `taskindex/draft-writer/${scope}`,
          { ifAvailable: true },
          async (lock) => {
            resolve(!!lock);
            if (lock) await new Promise<void>(() => {});
          },
        )
        .catch(() => resolve(false));
    });
  let scope: string | undefined;
  const choices = previous
    ? [previous]
    : candidates.sort((a, b) => b.at - a.at).map((item) => item.scope);
  for (const candidate of new Set(choices))
    if (await claim(candidate)) {
      scope = candidate;
      break;
    }
  if (!scope) {
    scope = crypto.randomUUID();
    await claim(scope);
    // A duplicated tab starts from the same text, but gets independent records.
    // Also retain the old records if Web Locks are unavailable.
    const source = previous ?? (!navigator.locks ? choices[0] : undefined);
    if (source)
      try {
        const sourcePrefix = prefix(source);
        const copies: [string, string][] = [];
        for (let i = 0; i < (storage?.length ?? 0); i++) {
          const key = storage!.key(i)!;
          if (key.startsWith(sourcePrefix))
            copies.push([
              key.slice(sourcePrefix.length),
              storage!.getItem(key)!,
            ]);
        }
        for (const [id, value] of copies)
          storage!.setItem(`${prefix(scope)}${id}`, value);
        if (copies.length)
          storage!.setItem(`${scopePrefix}${scope}`, String(Date.now()));
      } catch {
        /* Never delete the source if copying fails. */
      }
  }
  drafts = new DraftStorage(storage, scope);
  try {
    sessionStorage.setItem(tabKey, scope);
  } catch {
    /* This document still has an independent writer when storage is disabled. */
  }
}
export function readDraft<T>(id: string): Draft<T> | null {
  return drafts.read<T>(id);
}
export function writeDraft<T>(id: string, draft: Draft<T>) {
  drafts.write(id, draft);
}
export function clearDraft(id: string) {
  drafts.clear(id);
}
export function subscribeDraft(id: string, listener: () => void) {
  return drafts.subscribe(id, listener);
}
