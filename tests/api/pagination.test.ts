import { afterEach, describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import { generation, latestSeq } from '../../src/server/db.js';
import type { Page } from '../../src/shared/model.js';
// Plan 01, test 6 (TI-037): a walk over pages survives a write between them.
// Journals (operations, history, comments) continue from a monotonic
// position; the task list continues from its (orderKey, id) key and marks the
// change through Page.seq.
const cleanup: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
type Row = { id: string; seq?: number };
const get = async <T extends Row>(
  f: ReturnType<typeof fixture>,
  path: string,
) => {
  const response = await f.app.request(path);
  return { status: response.status, page: (await response.json()) as Page<T> };
};
// Walks every page of `path`, running `between` after the first page.
async function walk<T extends Row>(
  f: ReturnType<typeof fixture>,
  path: string,
  between: () => Promise<unknown>,
) {
  const pages: Page<T>[] = [];
  let cursor: string | null = null;
  do {
    const { status, page }: { status: number; page: Page<T> } = await get<T>(
      f,
      cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path,
    );
    expect(status).toBe(200);
    pages.push(page);
    if (pages.length === 1) await between();
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}
const cursorOf = (fields: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(fields)).toString('base64url');
async function seed(f: ReturnType<typeof fixture>) {
  await f.batch(
    Array.from({ length: 20 }, (_, i) => ({
      command: 'task.create' as const,
      payload: {
        id: `t-${String(i).padStart(2, '0')}`,
        area: 'agency' as const,
        title: `T${i}`,
        due: `2026-09-${String(1 + (i % 9)).padStart(2, '0')}`,
      },
    })),
  );
  for (const n of [1, 2, 3, 4, 5])
    success(
      await f.post({
        command: 'comment.add',
        payload: { id: `c${n}`, taskId: 't-00', text: `C${n}` },
      }),
    );
  for (const n of [1, 2, 3, 4])
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 't-00', baseRevision: n, note: `N${n}` },
      }),
    );
}
describe('keyset pagination (plan 01, phase 2)', () => {
  it('journals and the task list continue after a write to another entity without duplicates or gaps', async () => {
    const f = setup();
    await seed(f);
    let revision = 1;
    const write = async () => {
      success(
        await f.post({
          command: 'task.update',
          payload: {
            id: 't-19',
            baseRevision: revision,
            note: `elsewhere ${revision}`,
          },
        }),
      );
      revision++;
    };
    for (const [path, expected] of [
      [
        '/api/tasks?limit=7',
        Array.from({ length: 20 }, (_, i) => `t-${String(i).padStart(2, '0')}`),
      ],
      ['/api/tasks/t-00/comments?limit=2', ['c1', 'c2', 'c3', 'c4', 'c5']],
      ['/api/focus?group=due&limit=3', undefined],
    ] as const) {
      const pages = await walk(f, path, write);
      const ids = pages.flatMap((p) => p.items.map((i) => i.id));
      expect(new Set(ids).size).toBe(ids.length);
      const { page: full } = await get(
        f,
        `${path.split('?')[0]}?limit=500${path.includes('group') ? '&group=due' : ''}`,
      );
      expect(ids).toEqual(full.items.map((i) => i.id));
      if (expected) expect(ids).toEqual(expected);
      // The seq of a page is the journal position at the answer: the walk
      // shows the change through it (list_changed_during_walk in the CLI).
      expect(pages[0]!.seq).toBeLessThan(pages.at(-1)!.seq);
    }
    const history = await walk<Row>(
      f,
      '/api/tasks/t-00/history?limit=3',
      write,
    );
    const seqs = history.flatMap((p) => p.items.map((i) => i.seq!));
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toHaveLength(1 + 4);
    const operations = await walk<Row>(f, '/api/operations?limit=4', write);
    const opIds = operations.flatMap((p) => p.items.map((i) => i.id));
    expect(new Set(opIds).size).toBe(opIds.length);
    const { page: allOps } = await get(f, '/api/operations?limit=500');
    // The write between pages is newer than the first page: it is the only
    // operation the walk does not show.
    expect(
      allOps.items.map((i) => i.id).filter((id) => opIds.includes(id)),
    ).toEqual(opIds);
    expect(allOps.items.length - opIds.length).toBeLessThanOrEqual(2);
  });
  it('rejects cursors of another generation, another query and the old format', async () => {
    const f = setup();
    await seed(f);
    const { page } = await get(f, '/api/tasks?limit=5');
    const key = JSON.parse(
      Buffer.from(page.nextCursor!, 'base64url').toString(),
    ) as { v: number; generation: string; query: string; key: unknown };
    expect(key).toMatchObject({ v: 2, generation: generation(f.db) });
    const foreign = await get(
      f,
      `/api/tasks?limit=5&cursor=${cursorOf({ ...key, generation: 'other' })}`,
    );
    expect(foreign.status).toBe(409);
    expect(foreign.page).toMatchObject({ code: 'generation_changed' });
    const otherQuery = await get(
      f,
      `/api/tasks?limit=5&area=personal&cursor=${page.nextCursor}`,
    );
    expect(otherQuery.status).toBe(400);
    expect(otherQuery.page).toMatchObject({ code: 'invalid' });
    const old = await get(
      f,
      `/api/tasks?limit=5&cursor=${cursorOf({
        generation: generation(f.db),
        seq: latestSeq(f.db),
        offset: 5,
        query: key.query,
        fingerprint: 'x',
      })}`,
    );
    expect(old.status).toBe(400);
    expect(old.page).toMatchObject({ code: 'invalid' });
    const garbage = await get(f, '/api/tasks?limit=5&cursor=not-a-cursor');
    expect(garbage.status).toBe(400);
    const wrongKey = await get(
      f,
      `/api/tasks/t-00/comments?limit=2&cursor=${cursorOf({ ...key, query: 'comments:t-00', key: { seq: 1 } })}`,
    );
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.page).toMatchObject({ code: 'invalid' });
  });
});
