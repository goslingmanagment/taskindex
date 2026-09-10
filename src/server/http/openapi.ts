import { z } from 'zod';
import { booleanQuery, idSchema } from '../../shared/schemas.js';
import { operationErrorSchema } from '../../shared/domain-schemas.js';
import { LIMITS } from '../../shared/limits.js';

// The response and query shapes every route repeats. Kept together so a new
// route describes only what is new about it.
export const json = <T extends z.ZodType>(
  schema: T,
  description = 'Ответ приложения',
) => ({ description, content: { 'application/json': { schema } } });

export const generationQuery = idSchema
  .optional()
  .describe('Поколение базы; при несовпадении 409 generation_changed');

export const pageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.pageSize)
    .default(100)
    .describe(`Размер страницы 1-${LIMITS.pageSize}`),
  cursor: z
    .string()
    .optional()
    .describe('Курсор из nextCursor предыдущей страницы того же запроса'),
  generation: generationQuery,
});

export const flag = (description: string) =>
  booleanQuery.optional().describe(`${description}: true/false или 1/0`);

export const idParam = z.object({
  id: idSchema.describe('Идентификатор записи'),
});

export const readErrors = {
  400: json(operationErrorSchema, 'Неверные параметры: issues по полям'),
  401: json(operationErrorSchema, 'Нет сессии владельца или ключа агента'),
  403: json(operationErrorSchema, 'Недостаточно прав или недопустимый Origin'),
  404: json(operationErrorSchema, 'Запись не найдена'),
  409: json(
    operationErrorSchema,
    'Конфликт: generation_changed, conflict, operation_mismatch, not_undoable',
  ),
  503: json(operationErrorSchema, 'База недоступна или запись закрыта'),
};

// A stored operation as the journal routes publish it: without the full
// result body and without the envelope hash.
export const stripStored = <
  T extends { result: unknown; commandHash: string },
>({
  result: _result,
  commandHash: _hash,
  ...summary
}: T) => summary;
