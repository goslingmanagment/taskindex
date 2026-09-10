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
type Draft<T> = {
  formatVersion: 1;
  generation: string;
  baseRevision: number;
  fields: T;
  id?: string;
  operationId?: string;
};
const scopePrefix = 'taskindex/draft-scope/';
// План 04, доп. 16: испорченная запись не выбрасывается и не роняет загрузку.
// Она переносится под служебный префикс, чтобы владелец мог достать из неё
// текст, и один раз попадает в консоль. Повторно её уже не читают.
const CORRUPT_PREFIX = 'taskindex/corrupt/';
export function quarantine(
  storage: StorageLike | undefined,
  key: string,
  reason: string,
) {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) return;
    storage?.setItem(`${CORRUPT_PREFIX}${key}`, raw);
    storage?.removeItem(key);
    console.warn(
      `Запись «${key}» не прочитана (${reason}); перенесена в ${CORRUPT_PREFIX}${key}`,
    );
  } catch {
    /* Хранилище может быть недоступно: тогда запись просто пропускается. */
  }
}
const tabKey = 'taskindex/draft-tab';
const prefix = (scope: string) =>
  scope === 'legacy' ? 'taskindex/draft/' : `taskindex/drafts/${scope}/`;
/** @internal for tests */
export class DraftStorage {
  private listeners = new Map<string, Set<() => void>>();
  private values = new Map<string, Draft<unknown> | null>();
  constructor(
    private storage: StorageLike | undefined,
    readonly scope: string,
  ) {}
  read<T>(id: string): Draft<T> | null {
    if (this.values.has(id)) return this.values.get(id) as Draft<T> | null;
    const key = `${prefix(this.scope)}${id}`;
    let raw: string | null | undefined;
    try {
      raw = this.storage?.getItem(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      quarantine(this.storage, key, 'не разбирается как JSON');
      return null;
    }
    const draft = value as Partial<Draft<T>> | null;
    if (!draft || typeof draft !== 'object') {
      quarantine(this.storage, key, 'не объект');
      return null;
    }
    if (draft.formatVersion !== 1) {
      quarantine(
        this.storage,
        key,
        `неизвестный formatVersion ${String(draft.formatVersion)}`,
      );
      return null;
    }
    if (draft.fields === null || draft.fields === undefined) {
      quarantine(this.storage, key, 'нет полей');
      return null;
    }
    return draft as Draft<T>;
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
// TI-041: without Web Locks a reload keeps the previous scope instead of cloning
// it; scopes unused for DRAFT_SCOPE_TTL_MS and not held by a live tab are removed.
/** @internal for tests */
export const DRAFT_SCOPE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
type ScopeDeps = {
  storage?: StorageLike;
  session?: Pick<StorageLike, 'getItem' | 'setItem'>;
  locks?: LockManager;
  now: () => number;
  id?: () => string;
};
type Candidate = { scope: string; at: number };
function listCandidates(storage: StorageLike | undefined): Candidate[] {
  const candidates = new Map<string, Candidate>();
  const add = (scope: string, at: number) => {
    const known = candidates.get(scope);
    if (!known || known.at < at) candidates.set(scope, { scope, at });
  };
  try {
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const key = storage!.key(i)!;
      if (key.startsWith(scopePrefix))
        add(key.slice(scopePrefix.length), Number(storage!.getItem(key)) || 0);
      else if (key.startsWith(prefix('legacy'))) add('legacy', 0);
      else if (key.startsWith('taskindex/drafts/')) {
        const scope = key.slice('taskindex/drafts/'.length).split('/')[0];
        if (scope) add(scope, 0);
      }
    }
  } catch {
    /* Storage access can be disabled by the browser. */
  }
  return [...candidates.values()].sort((a, b) => b.at - a.at);
}
// Resolves to true when the lock is free. With hold=true it is kept for the
// lifetime of this document; otherwise it is released at once (a liveness probe).
function claim(locks: LockManager | undefined, scope: string, hold: boolean) {
  return new Promise<boolean>((resolve) => {
    if (!locks) return resolve(false);
    void locks
      .request(
        `taskindex/draft-writer/${scope}`,
        { ifAvailable: true },
        async (lock) => {
          resolve(!!lock);
          if (lock && hold) await new Promise<void>(() => {});
        },
      )
      .catch(() => resolve(false));
  });
}
function copyScope(
  storage: StorageLike | undefined,
  source: string,
  target: string,
  now: number,
) {
  try {
    const sourcePrefix = prefix(source);
    const copies: [string, string][] = [];
    for (let i = 0; i < (storage?.length ?? 0); i++) {
      const key = storage!.key(i)!;
      if (key.startsWith(sourcePrefix))
        copies.push([key.slice(sourcePrefix.length), storage!.getItem(key)!]);
    }
    for (const [id, value] of copies)
      storage!.setItem(`${prefix(target)}${id}`, value);
    if (copies.length) storage!.setItem(`${scopePrefix}${target}`, String(now));
  } catch {
    /* Never delete the source if copying fails. */
  }
}
function removeScope(storage: StorageLike, scope: string) {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (key.startsWith(prefix(scope))) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
  storage.removeItem(`${scopePrefix}${scope}`);
}
/** @internal for tests */
export async function chooseScope(
  deps: ScopeDeps,
): Promise<{ scope: string; removed: string[] }> {
  const { storage, session, locks, now } = deps;
  const newId = deps.id ?? (() => crypto.randomUUID());
  let previous: string | null = null;
  try {
    previous = session?.getItem(tabKey) ?? null;
  } catch {
    /* Persistent drafts can still be recovered without sessionStorage. */
  }
  const candidates = listCandidates(storage);
  let scope: string | undefined;
  if (locks) {
    const choices = previous
      ? [previous]
      : candidates.map((candidate) => candidate.scope);
    for (const candidate of new Set(choices))
      if (await claim(locks, candidate, true)) {
        scope = candidate;
        break;
      }
    if (!scope) {
      scope = newId();
      await claim(locks, scope, true);
      // A duplicated tab starts from the same text, but gets independent records.
      if (previous) copyScope(storage, previous, scope, now());
    }
  } else if (previous) {
    // No liveness check is possible: this tab keeps its own scope across reloads.
    scope = previous;
  } else {
    scope = newId();
    const freshest = candidates.find(
      (candidate) => candidate.scope !== 'legacy',
    );
    if (freshest) copyScope(storage, freshest.scope, scope, now());
  }
  const removed: string[] = [];
  if (storage)
    for (const candidate of candidates) {
      if (candidate.scope === scope || candidate.scope === 'legacy') continue;
      if (now() - candidate.at < DRAFT_SCOPE_TTL_MS) continue;
      if (locks && !(await claim(locks, candidate.scope, false))) continue;
      try {
        removeScope(storage, candidate.scope);
        removed.push(candidate.scope);
      } catch {
        /* Storage may be unavailable. */
      }
    }
  try {
    session?.setItem(tabKey, scope);
  } catch {
    /* This document still has an independent writer when storage is disabled. */
  }
  return { scope, removed };
}
let drafts = new DraftStorage(browserStorage(), crypto.randomUUID());
let initialization: Promise<void> | undefined;
export function initializeDrafts(): Promise<void> {
  return (initialization ??= initialize());
}
async function initialize() {
  const storage = browserStorage();
  let session: ScopeDeps['session'];
  try {
    session =
      typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    session = undefined;
  }
  const { scope } = await chooseScope({
    storage,
    session,
    locks: typeof navigator === 'undefined' ? undefined : navigator.locks,
    now: () => Date.now(),
  });
  drafts = new DraftStorage(storage, scope);
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
