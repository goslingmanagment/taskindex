import { and, asc, eq, gt, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import type { DatabaseHandle } from './sqlite.js';
import { generation } from './sqlite.js';
import type {
  DomainEvent,
  EntityKind,
  OperationResponse,
  OperationSuccess,
} from '../shared/model.js';
import type { HistoryAccess } from '../shared/commands.js';
import type { StoredResult } from './schema.js';

// The event journal: indexed selections for the reducer (plan 01, step 2),
// the tail for SSE and /api/events, and the two codecs of a stored result.
type EventRow = typeof schema.events.$inferSelect;
// The one place a journal row becomes the event clients see: the generation
// is stamped on, an absent taskId is dropped.
export const toEvent =
  (gen: string) =>
  ({ taskId, ...e }: EventRow): DomainEvent =>
    ({ ...e, generation: gen, ...(taskId ? { taskId } : {}) }) as DomainEvent;

// Events of one operation straight from the journal (index events_operation).
export function readEventsForOperation(
  db: DatabaseHandle,
  operationId: string,
): DomainEvent[] {
  return db.orm
    .select()
    .from(schema.events)
    .where(eq(schema.events.operationId, operationId))
    .orderBy(asc(schema.events.seq))
    .all()
    .map(toEvent(generation(db)));
}
// History of one record after a revision (index events_entity_revision);
// `page` turns it into a keyset slice for GET /api/tasks/{id}/history.
export function readEventsForRecord(
  db: DatabaseHandle,
  kind: EntityKind,
  id: string,
  afterRevision: number,
  page?: { afterSeq: number; limit: number },
): DomainEvent[] {
  const query = db.orm
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityKind, kind),
        eq(schema.events.entityId, id),
        gt(schema.events.recordRevision, afterRevision),
        ...(page ? [gt(schema.events.seq, page.afterSeq)] : []),
      ),
    )
    .orderBy(asc(schema.events.seq));
  return (page ? query.limit(page.limit).all() : query.all()).map(
    toEvent(generation(db)),
  );
}
// Owner comments after `since` for the digest: the journal filtered in SQL
// (entity_kind first in events_entity_revision), not the whole tail parsed.
export function readOwnerCommentEvents(
  db: DatabaseHandle,
  since: number,
  limit: number,
): DomainEvent[] {
  return db.orm
    .select()
    .from(schema.events)
    .where(
      and(
        gt(schema.events.seq, since),
        eq(schema.events.entityKind, 'comment'),
        eq(schema.events.command, 'comment.add'),
        sql`${schema.events.actorId} NOT LIKE 'agent:%'`,
      ),
    )
    .orderBy(asc(schema.events.seq))
    .limit(limit)
    .all()
    .map(toEvent(generation(db)));
}
export function readEventBySeq(
  db: DatabaseHandle,
  seq: number,
): DomainEvent | undefined {
  const row = db.orm
    .select()
    .from(schema.events)
    .where(eq(schema.events.seq, seq))
    .get();
  return row ? toEvent(generation(db))(row) : undefined;
}
// The reducer's view of the journal while a packet runs: indexed queries plus
// the events the packet has already produced (`overlay`), filtered by the
// same conditions. The journal is never truncated or compacted (plan 01,
// additional step 14): every event matching the selection is returned.
export function serverHistory(
  db: DatabaseHandle,
  overlay: DomainEvent[],
): HistoryAccess {
  return {
    forRecord: (kind, id, afterRevision) => [
      ...readEventsForRecord(db, kind, id, afterRevision),
      ...overlay.filter(
        (e) =>
          e.entityKind === kind &&
          e.entityId === id &&
          e.recordRevision > afterRevision,
      ),
    ],
    forOperation: (operationId) => [
      ...readEventsForOperation(db, operationId),
      ...overlay.filter((e) => e.operationId === operationId),
    ],
    bySeq: (seq) =>
      readEventBySeq(db, seq) ?? overlay.find((e) => e.seq === seq),
  };
}
// The result as clients see it: a success stored without its events gets them
// back from the journal, a row of the older format keeps its own copy.
export function withEvents(
  result: StoredResult,
  events: DomainEvent[],
): OperationResponse {
  if (!result.ok) return result;
  return result.events ? (result as OperationSuccess) : { ...result, events };
}
export function withoutEvents(result: OperationResponse): StoredResult {
  if (!result.ok) return result;
  const { events: _events, ...rest } = result;
  return rest;
}
export function readEvents(
  db: DatabaseHandle,
  since = 0,
  limit?: number,
): DomainEvent[] {
  const query = db.orm
    .select()
    .from(schema.events)
    .where(gt(schema.events.seq, since))
    .orderBy(asc(schema.events.seq));
  return (limit ? query.limit(limit).all() : query.all()).map(
    toEvent(generation(db)),
  );
}
