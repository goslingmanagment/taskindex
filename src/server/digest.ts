import type { Digest, Entity, OperationSummary } from '../shared/model.js';
import { LIMITS } from '../shared/limits.js';
import { focusGroups, queryTasks, todayInTimezone } from '../shared/queries.js';
import {
  generation,
  latestOperationSeq,
  latestSeq,
  readEvents,
  readOperations,
  readState,
  withRead,
} from './db.js';
import { stripStored } from './http/openapi.js';
import type { Deps } from './http/deps.js';

// First page of every section with an href to the full list. One consistent
// read: the sections must describe the same seq.
export function buildDigest(
  deps: Deps,
  query: { since: number; sinceOp?: number },
): Digest {
  const { db, now, timezone, page } = deps;
  const since = query.since;
  return withRead(db, (): Digest => {
    const state = readState(db);
    const seq = latestSeq(db);
    const operationSeq = latestOperationSeq(db);
    const gen = generation(db);
    const today = todayInTimezone(timezone(), now());
    const groups = focusGroups(state.tasks, today);
    const ops = readOperations(db)
      .filter(
        (o) =>
          (query.sinceOp === undefined || o.operationSeq > query.sinceOp) &&
          (!since || (o.lastSeq ?? 0) > since) &&
          (o.lastSeq ?? 0) <= seq,
      )
      .reverse()
      .map(stripStored);
    const operationPage = page<OperationSummary>(
      ops,
      { limit: LIMITS.digestPage },
      `operations:${JSON.stringify({ since, sinceOp: query.sinceOp ?? null, until: seq })}`,
    );
    const titles = new Map(state.tasks.map((t) => [t.id, t.title]));
    const byId = new Map(state.comments.map((x) => [x.id, x]));
    // Owner comments in event order: the agent reads them forward and
    // continues with since = seq of the last one shown.
    const comments = readEvents(db, since).flatMap((e) => {
      const comment =
        e.entityKind === 'comment' &&
        e.command === 'comment.add' &&
        !e.actorId.startsWith('agent:')
          ? byId.get(e.entityId)
          : undefined;
      return comment && !comment.deletedAt
        ? [
            {
              ...comment,
              taskTitle: titles.get(comment.taskId) ?? '',
              seq: e.seq,
            },
          ]
        : [];
    });
    const limitPart = <T extends Entity>(
      items: T[],
      href: string,
      identity: string,
    ) => ({
      ...page(items, { limit: LIMITS.digestPage }, identity),
      href,
    });
    return {
      generation: gen,
      seq,
      operationSeq,
      today,
      timezone: timezone(),
      focus: groups.map((g) => ({
        ...g,
        tasks: g.tasks.slice(0, LIMITS.digestPage),
        more: g.tasks.length > LIMITS.digestPage,
        nextCursor: page(g.tasks, { limit: LIMITS.digestPage }, `focus:${g.id}`)
          .nextCursor,
        href: `/api/focus?group=${g.id}&generation=${gen}`,
      })),
      waiting: limitPart(
        queryTasks(state.tasks, state.projects, {
          status: 'waiting',
          hasFollowUp: true,
        }),
        `/api/tasks?status=waiting&hasFollowUp=true&generation=${gen}`,
        `tasks:${JSON.stringify({ status: 'waiting', hasFollowUp: 'true' })}`,
      ),
      counts: {
        tasks: state.tasks.length,
        archived: state.tasks.filter((t) => t.archived).length,
        projects: state.projects.length,
      },
      operations: {
        ...operationPage,
        href:
          query.sinceOp === undefined
            ? `/api/operations?since=${since}&until=${seq}&generation=${gen}`
            : `/api/operations?after=${query.sinceOp}&generation=${gen}`,
      },
      comments: {
        generation: gen,
        seq,
        items: comments.slice(0, LIMITS.digestPage),
        more: comments.length > LIMITS.digestPage,
        nextCursor: null,
        href: `/api/events?generation=${gen}&since=${since}`,
      },
    };
  });
}
