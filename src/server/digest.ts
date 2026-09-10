import type { Digest, Task } from '../shared/model.js';
import { LIMITS } from '../shared/limits.js';
import {
  focusDesk,
  focusGroups,
  queryTasks,
  todayInTimezone,
} from '../shared/queries.js';
import {
  generation,
  latestOperationSeq,
  latestSeq,
  readOperationsPage,
  readOwnerCommentEvents,
  withRead,
} from './db.js';
import { stripStored } from './http/openapi.js';
import { focusKey, taskKey } from './http/pagination.js';
import type { Key } from './http/pagination.js';
import type { Deps } from './http/deps.js';

// First page of every section with an href to the full list. One consistent
// read: the sections must describe the same seq. Every nextCursor is the
// keyset cursor of the list behind the href, so href + cursor continues it.
export function buildDigest(
  deps: Deps,
  query: { since: number; sinceOp?: number },
): Digest {
  const { db, now, timezone, paging, projection } = deps;
  const since = query.since;
  const limit = LIMITS.digestPage;
  return withRead(db, (): Digest => {
    const state = projection.read();
    const seq = latestSeq(db);
    const operationSeq = latestOperationSeq(db);
    const gen = generation(db);
    const today = todayInTimezone(timezone(), now());
    // sinceOp reads the journal forward from a position (the list behind
    // after=); without it the window by events (since, seq] reads newest
    // first. With sinceOp the event window `since` does not apply.
    const window =
      query.sinceOp === undefined
        ? { since, until: seq }
        : { after: query.sinceOp };
    const operations = readOperationsPage(db, { ...window, limit });
    const titles = new Map(state.tasks.map((t) => [t.id, t.title]));
    const byId = new Map(state.comments.map((x) => [x.id, x]));
    // Owner comments in event order: the agent reads them forward and
    // continues with since = seq of the last one shown.
    const comments = readOwnerCommentEvents(db, since, limit + 1).flatMap(
      (e) => {
        const comment = byId.get(e.entityId);
        return comment && !comment.deletedAt
          ? [
              {
                ...comment,
                taskTitle: titles.get(comment.taskId) ?? '',
                seq: e.seq,
              },
            ]
          : [];
      },
    );
    const desk = focusDesk(state.tasks, today);
    const tasksPage = (
      items: Task[],
      identity: string,
      keyOf: (t: Task) => Key,
    ) => paging.keysetPage(items, { limit }, identity, keyOf);
    return {
      generation: gen,
      seq,
      operationSeq,
      today,
      timezone: timezone(),
      focus: focusGroups(state.tasks, today).map((g) => {
        const page = tasksPage(g.tasks, `focus:${g.id}`, focusKey(g.id));
        return {
          ...g,
          tasks: page.items,
          more: page.more,
          nextCursor: page.nextCursor,
          href: `/api/focus?group=${g.id}&generation=${gen}`,
        };
      }),
      current: desk.current,
      next: desk.next,
      waiting: {
        ...tasksPage(
          queryTasks(state.tasks, state.projects, {
            status: 'waiting',
            hasFollowUp: true,
          }),
          `tasks:${JSON.stringify({ status: 'waiting', hasFollowUp: true })}`,
          taskKey,
        ),
        href: `/api/tasks?status=waiting&hasFollowUp=true&generation=${gen}`,
      },
      counts: {
        tasks: state.tasks.length,
        archived: state.tasks.filter((t) => t.archived).length,
        projects: state.projects.length,
      },
      operations: {
        ...paging.pageOf(
          operations.rows.map(stripStored),
          operations.more,
          `operations:${JSON.stringify(window)}`,
          (o) => ({ operationSeq: o.operationSeq }),
        ),
        href:
          query.sinceOp === undefined
            ? `/api/operations?since=${since}&until=${seq}&generation=${gen}`
            : `/api/operations?after=${query.sinceOp}&generation=${gen}`,
      },
      comments: {
        generation: gen,
        seq,
        items: comments.slice(0, limit),
        more: comments.length > limit,
        nextCursor: null,
        href: `/api/events?generation=${gen}&since=${since}`,
      },
    };
  });
}
