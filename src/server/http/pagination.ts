import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '../../shared/schemas.js';
import { fail } from '../../shared/errors.js';
import type { Page } from '../../shared/model.js';
import { generation, latestSeq } from '../db.js';
import type { DatabaseHandle } from '../db.js';
import type { PageRequest } from './deps.js';

const cursorSchema = z.object({
  generation: idSchema,
  seq: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  query: z.string(),
  fingerprint: z.string(),
});

// Pages are stable inside one seq: the cursor carries the generation, the seq
// and a fingerprint of the whole list, so data that changed between pages is a
// conflict instead of a silently shifted window.
export function createPagination(db: DatabaseHandle) {
  const checkGeneration = (given?: string) => {
    if (given && given !== generation(db))
      fail('generation_changed', 'Поколение базы изменилось.', {
        generation: generation(db),
      });
  };
  function page<T>(items: T[], query: PageRequest, identity: string): Page<T> {
    checkGeneration(query.generation);
    let offset = 0;
    let seq = latestSeq(db);
    const gen = generation(db);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(items))
      .digest('hex');
    if (query.cursor) {
      let cursor: z.infer<typeof cursorSchema>;
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
      if (cursor.seq !== latestSeq(db) || cursor.fingerprint !== fingerprint)
        fail('conflict', 'Данные изменились. Начните чтение страниц заново.');
      offset = cursor.offset;
      seq = cursor.seq;
    }
    const chunk = items.slice(offset, offset + query.limit);
    const more = offset + chunk.length < items.length;
    return {
      generation: gen,
      seq,
      items: chunk,
      more,
      nextCursor: more
        ? Buffer.from(
            JSON.stringify({
              generation: gen,
              seq,
              offset: offset + chunk.length,
              query: identity,
              fingerprint,
            }),
          ).toString('base64url')
        : null,
    };
  }
  return { checkGeneration, page };
}
