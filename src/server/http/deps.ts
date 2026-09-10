import type { Actor } from '../../shared/model.js';
import type { DatabaseHandle } from '../db.js';
import type { Auth, Authorized } from '../auth.js';
import type { EventHub } from '../sse.js';
import type { Logger } from '../log.js';
import type { Pagination } from './pagination.js';
import type { Projection } from '../projection.js';

export type AppOptions = {
  db: DatabaseHandle;
  auth?: Auth;
  // Tests may return a bare Actor: it is treated as static (never revoked).
  authorize?: (
    request: Request,
  ) => Actor | Authorized | null | Promise<Actor | Authorized | null>;
  build?: string;
  baseURL?: string;
  trustedOrigins?: string[];
  writes?: 'held' | 'open';
  deploymentId?: string;
  migrationsDir?: string;
  sseHeartbeatMs?: number;
  // Events a reconnecting cursor may be behind before the stream answers
  // `event: reset` instead of a tail (plan 01, step 10).
  sseBacklogLimit?: number;
  // `false` reads the state from the database on every request (plan 01,
  // step 11 rollback).
  projectionCache?: boolean;
  logger?: Logger;
  hub?: EventHub;
  now?: () => string;
  ids?: () => string;
};

export type Env = {
  Variables: {
    actor: Actor;
    auth: Authorized;
    requestId: string;
    operationId?: string;
    commandName?: string;
  };
};

export type PageRequest = {
  limit: number;
  cursor?: string;
  generation?: string;
};

// What every route module is given: the database, the assembled options and
// the few functions that must stay identical across routes (clock, timezone,
// write gate, generation check, paging).
export type Deps = {
  db: DatabaseHandle;
  options: AppOptions;
  logger: Logger;
  hub: EventHub;
  version: number;
  heartbeatMs: number;
  backlogLimit: number;
  origins: string[];
  now: () => string;
  timezone: () => string;
  opened: () => boolean;
  checkGeneration: (given?: string) => void;
  paging: Pagination;
  projection: Projection;
};
