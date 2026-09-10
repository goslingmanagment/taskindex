import { z } from 'zod';
import { idSchema } from '../../shared/schemas.js';
import { fail } from '../../shared/errors.js';
import { compareStrings } from '../../shared/queries.js';
import type { FocusGroup, Page, Task } from '../../shared/model.js';
import { generation, latestSeq } from '../db.js';
import type { DatabaseHandle } from '../db.js';
import type { PageRequest } from './deps.js';

// A cursor names a position in one list, not a snapshot of it (plan 01,
// step 7): the key of the last item shown, the generation and the identity
// of the query. Journals (operations, history, comments) continue from a
// monotonic position; the task list continues from (orderKey, id) and may
// show a moved item twice or not at all — the one consistent full list is
// /api/snapshot. Cursors of the previous format (no `v`) are invalid.
export type Key = Record<string, string | number>;
const keySchema = z.record(z.string(), z.union([z.string(), z.number()]));
const cursorSchema = z.object({
  v: z.literal(2),
  generation: idSchema,
  query: z.string(),
  key: keySchema,
});
type Cursor = z.infer<typeof cursorSchema>;
// Keys compare field by field in the order the list is sorted, which is the
// order the fields appear in `keyOf(item)`.
function compareKeys(fields: string[], a: Key, b: Key): number {
  for (const field of fields) {
    const x = a[field],
      y = b[field];
    if (typeof x !== typeof y || x === undefined || y === undefined)
      fail('invalid', 'Неверный курсор.');
    const order =
      typeof x === 'number'
        ? x - (y as number)
        : compareStrings(x, y as string);
    if (order) return order;
  }
  return 0;
}
// A field of the cursor key with the type the list expects.
export function keyField<T extends 'string' | 'number'>(
  key: Key,
  name: string,
  type: T,
): T extends 'string' ? string : number {
  const value = key[name];
  if (typeof value !== type) fail('invalid', 'Неверный курсор.');
  return value as T extends 'string' ? string : number;
}
export const taskKey = (t: Task): Key => ({ orderKey: t.orderKey, id: t.id });
// The sort of every Focus group (`focusGroups`): due and follow-ups first by
// their date, then the board order; the others by the board order alone.
export const focusKey =
  (group: FocusGroup['id']) =>
  (t: Task): Key => {
    if (group === 'due') return { due: t.due ?? '', ...taskKey(t) };
    if (group === 'follow-ups')
      return { followUp: t.followUp ?? '', ...taskKey(t) };
    return taskKey(t);
  };
export type Pagination = ReturnType<typeof createPagination>;
export function createPagination(db: DatabaseHandle) {
  const checkGeneration = (given?: string) => {
    if (given && given !== generation(db))
      fail('generation_changed', 'Поколение базы изменилось.', {
        generation: generation(db),
      });
  };
  // The key the cursor of `query` names for the list `identity`, or
  // undefined for a first page.
  function cursorKey(query: PageRequest, identity: string): Key | undefined {
    checkGeneration(query.generation);
    if (!query.cursor) return undefined;
    let cursor: Cursor;
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString()),
      );
    } catch {
      fail('invalid', 'Неверный курсор.');
    }
    checkGeneration(cursor.generation);
    if (cursor.query !== identity)
      fail('invalid', 'Курсор относится к другому запросу.');
    return cursor.key;
  }
  function pageOf<T>(
    items: T[],
    more: boolean,
    identity: string,
    keyOf: (item: T) => Key,
  ): Page<T> {
    const last = items.at(-1);
    return {
      generation: generation(db),
      seq: latestSeq(db),
      items,
      more,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({
                v: 2,
                generation: generation(db),
                query: identity,
                key: keyOf(last),
              } satisfies Cursor),
            ).toString('base64url')
          : null,
    };
  }
  // A page of a list computed in memory and already sorted by its key
  // (/api/tasks, /api/focus?group=): the items after the cursor's key.
  function keysetPage<T>(
    items: T[],
    query: PageRequest,
    identity: string,
    keyOf: (item: T) => Key,
  ): Page<T> {
    const after = cursorKey(query, identity);
    const fields = items.length ? Object.keys(keyOf(items[0]!)) : [];
    const start = after
      ? items.findIndex((item) => compareKeys(fields, keyOf(item), after) > 0)
      : 0;
    const rest = start < 0 ? [] : items.slice(start);
    return pageOf(
      rest.slice(0, query.limit),
      rest.length > query.limit,
      identity,
      keyOf,
    );
  }
  // A page of a list the database already sliced after the cursor's key
  // with limit + 1 rows: the extra row only says there is more.
  function slicePage<T>(
    rows: T[],
    query: PageRequest,
    identity: string,
    keyOf: (item: T) => Key,
  ): Page<T> {
    return pageOf(
      rows.slice(0, query.limit),
      rows.length > query.limit,
      identity,
      keyOf,
    );
  }
  return { checkGeneration, cursorKey, keysetPage, slicePage, pageOf };
}
