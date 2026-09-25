import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { dateSchema, PROPOSAL_STATUSES } from '../../shared/schemas.js';
import { pageSchema, proposalSchema } from '../../shared/domain-schemas.js';
import { fail } from '../../shared/errors.js';
import { findProposal } from '../../shared/proposals.js';
import { compareStrings, todayInTimezone } from '../../shared/queries.js';
import type { Proposal } from '../../shared/model.js';
import { idParam, json, pageQuery, readErrors } from '../http/openapi.js';
import type { Deps, Env } from '../http/deps.js';

// Agent proposals (spec 2026-09-25, plan §1.3): a list of their own, never
// part of the board, the snapshot or the digest. Any scope reads them.
export const registerProposalRoutes = <T extends OpenAPIHono<Env>>(
  app: T,
  deps: Deps,
) => {
  const { timezone, paging, projection } = deps;
  return app
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/proposals',
        operationId: 'listProposals',
        summary: 'Предложения агентов',
        description:
          'По времени создания (createdAt, id). status — статусы через запятую, since — дата создания не раньше YYYY-MM-DD в часовом поясе владельца.',
        tags: ['proposals'],
        request: {
          query: pageQuery.extend({
            status: z
              .string()
              .optional()
              .describe(
                `Статусы через запятую: ${PROPOSAL_STATUSES.join(', ')}`,
              ),
            since: dateSchema
              .unwrap()
              .optional()
              .describe('Созданные не раньше этой даты YYYY-MM-DD'),
          }),
        },
        responses: {
          200: json(pageSchema(proposalSchema).meta({ id: 'ProposalPage' })),
          ...readErrors,
        },
      }),
      (c) => {
        const q = c.req.valid('query');
        const statuses = q.status
          ?.split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        for (const status of statuses ?? [])
          if (!PROPOSAL_STATUSES.some((known) => known === status))
            fail('invalid', `Неизвестный статус предложения: ${status}.`, {
              issues: [
                {
                  path: 'query.status',
                  message: `Ожидается: ${PROPOSAL_STATUSES.join(', ')}`,
                },
              ],
            });
        const zone = timezone();
        const values = projection
          .read()
          .proposals.filter(
            (p) =>
              (!statuses?.length || statuses.includes(p.status)) &&
              (!q.since || todayInTimezone(zone, p.createdAt) >= q.since),
          )
          .toSorted(
            (a, b) =>
              compareStrings(a.createdAt, b.createdAt) ||
              compareStrings(a.id, b.id),
          );
        const identity = `proposals:${JSON.stringify({
          status: statuses ?? [],
          since: q.since ?? null,
        })}`;
        return c.json(
          paging.keysetPage(values, q, identity, (p: Proposal) => ({
            createdAt: p.createdAt,
            id: p.id,
          })),
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: 'get',
        path: '/api/proposals/{id}',
        operationId: 'getProposal',
        summary: 'Предложение по номеру или идентификатору',
        description:
          'Одна-две цифры это номер среди показанных сейчас, иначе идентификатор.',
        tags: ['proposals'],
        request: {
          params: z.object({
            id: idParam.shape.id.describe(
              'Номер среди показанных (1–15) или идентификатор',
            ),
          }),
        },
        responses: { 200: json(proposalSchema), ...readErrors },
      }),
      (c) =>
        c.json(findProposal(projection.read(), c.req.valid('param').id), 200),
    );
};
