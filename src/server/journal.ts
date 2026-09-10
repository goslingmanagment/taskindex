import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import type { DatabaseHandle } from './sqlite.js';
import { generation } from './sqlite.js';
import type { DomainEvent, StoredOperation } from '../shared/model.js';
import { readEvents, toEvent, withEvents } from './events.js';

type OperationRow = typeof schema.operations.$inferSelect;
// The operation journal as the routes and the export read it (plan 01,
// step 5): one row, one keyset page, or everything.
export type OperationRecord = StoredOperation & {
  operationSeq: number;
  commandHash: string;
};
// The summary of stored rows: the result with its events, the outcome flags
// and the titles of the tasks the events name. Events and titles come from
// one query each over the rows given, never one query per row.
function summarize(
  db: DatabaseHandle,
  rows: OperationRow[],
  eventsOf: (id: string) => DomainEvent[],
): OperationRecord[] {
  const refs = rows.map((o) => ({
    o,
    ids: [
      ...new Set(
        eventsOf(o.id).flatMap((e) => {
          const id = e.entityKind === 'task' ? e.entityId : e.taskId;
          return id ? [id] : [];
        }),
      ),
    ],
  }));
  const wanted = [...new Set(refs.flatMap((r) => r.ids.slice(0, 3)))];
  const titles = new Map(
    wanted.length
      ? db.orm
          .select({ id: schema.tasks.id, title: schema.tasks.title })
          .from(schema.tasks)
          .where(inArray(schema.tasks.id, wanted))
          .all()
          .map((t) => [t.id, t.title])
      : [],
  );
  return refs.map(({ o, ids }) => {
    const result = withEvents(o.result, eventsOf(o.id));
    return {
      ...o,
      result,
      ok: result.ok,
      ...(!result.ok
        ? { errorCode: result.code, errorMessage: result.message }
        : {}),
      taskCount: ids.length,
      titles: ids.slice(0, 3).map((id) => titles.get(id) ?? id),
    };
  });
}
const journalOf = (db: DatabaseHandle, ids: string[]) => {
  const grouped = Map.groupBy(
    ids.length
      ? db.orm
          .select()
          .from(schema.events)
          .where(inArray(schema.events.operationId, ids))
          .orderBy(asc(schema.events.seq))
          .all()
          .map(toEvent(generation(db)))
      : [],
    (e) => e.operationId,
  );
  return (id: string) => grouped.get(id) ?? [];
};
export function readOperation(
  db: DatabaseHandle,
  id: string,
): OperationRecord | undefined {
  const row = db.orm
    .select()
    .from(schema.operations)
    .where(eq(schema.operations.id, id))
    .get();
  return row ? summarize(db, [row], journalOf(db, [id]))[0] : undefined;
}
// One page of the journal (plan 01, step 5; key operationSeq, step 15).
// `after` reads forward from a position (the cursor of TI-008), ignoring the
// event window; otherwise the window since/until by lastSeq reads newest
// first. `cursor` continues either order from the last position shown.
export function readOperationsPage(
  db: DatabaseHandle,
  q: {
    actor?: string;
    after?: number;
    since?: number;
    until?: number;
    cursor?: { operationSeq: number };
    limit: number;
  },
): { rows: OperationRecord[]; more: boolean } {
  const forward = q.after !== undefined;
  const lastSeq = sql`COALESCE(${schema.operations.lastSeq}, 0)`;
  const rows = db.orm
    .select()
    .from(schema.operations)
    .where(
      and(
        ...(q.actor ? [eq(schema.operations.actorId, q.actor)] : []),
        ...(forward
          ? [
              gt(
                schema.operations.operationSeq,
                Math.max(q.after!, q.cursor?.operationSeq ?? 0),
              ),
            ]
          : [
              ...(q.since ? [sql`${lastSeq} > ${q.since}`] : []),
              ...(q.until !== undefined ? [sql`${lastSeq} <= ${q.until}`] : []),
              ...(q.cursor
                ? [lt(schema.operations.operationSeq, q.cursor.operationSeq)]
                : []),
            ]),
      ),
    )
    .orderBy(
      forward
        ? asc(schema.operations.operationSeq)
        : desc(schema.operations.operationSeq),
    )
    .limit(q.limit + 1)
    .all();
  const page = rows.slice(0, q.limit);
  return {
    rows: summarize(
      db,
      page,
      journalOf(
        db,
        page.map((o) => o.id),
      ),
    ),
    more: rows.length > q.limit,
  };
}
// Every operation, for the export: one scan of the journal grouped by
// operation instead of a query per row.
export function readOperations(db: DatabaseHandle): OperationRecord[] {
  const rows = db.orm
    .select()
    .from(schema.operations)
    .orderBy(asc(schema.operations.operationSeq))
    .all();
  const grouped = Map.groupBy(readEvents(db), (e) => e.operationId);
  return summarize(db, rows, (id) => grouped.get(id) ?? []);
}
