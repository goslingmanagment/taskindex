import type { WorkspaceState } from '../shared/model.js';
import type { DatabaseHandle } from './sqlite.js';
import { readState } from './db.js';

// The workspace state cached in the process (plan 01, step 11). A read costs
// one `PRAGMA data_version` and one `total_changes()`: the first moves when
// another connection commits (an admin command, sqlite3 in the container),
// the second when this connection writes outside the executor (import,
// tests). The executor replaces the cache with the state it just wrote, so
// its own commits never trigger a re-read. The returned state is shared:
// callers must not mutate it (`applyCommand` clones, the queries filter).
export type Projection = {
  read(): WorkspaceState;
  // The version of the database as this connection sees it right now.
  version(): string;
  replace(state: WorkspaceState, version: string): void;
};
export function createProjection(
  db: DatabaseHandle,
  enabled = true,
): Projection {
  let cache: { version: string; state: WorkspaceState } | undefined;
  const version = () => {
    const external = db.sqlite.pragma('data_version', {
      simple: true,
    }) as number;
    const own = (
      db.sqlite.prepare('SELECT total_changes() AS n').get() as { n: number }
    ).n;
    return `${external}:${own}`;
  };
  return {
    version,
    read() {
      if (!enabled) return readState(db);
      const v = version();
      if (cache?.version === v) return cache.state;
      const state = readState(db);
      cache = { version: v, state };
      return state;
    },
    replace(state, v) {
      if (enabled) cache = { version: v, state };
    },
  };
}
