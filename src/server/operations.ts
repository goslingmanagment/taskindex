import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { applyCommand } from '../shared/commands.js';
import { DomainError, fail } from '../shared/errors.js';
import {
  commandEnvelopeSchema,
  batchEnvelopeSchema,
  commandSchema,
} from '../shared/schemas.js';
import type {
  Actor,
  Command,
  DomainEvent,
  OperationEnvelope,
  OperationResponse,
  OperationSuccess,
} from '../shared/model.js';
import type { DatabaseHandle } from './db.js';
import {
  generation,
  latestSeq,
  readEvents,
  readState,
  writeState,
} from './db.js';
import * as schema from './schema.js';
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
export function executeOperation(
  db: DatabaseHandle,
  input: OperationEnvelope,
  actor: Actor,
  options: { now?: string; ids?: () => string } = {},
): {
  status: number;
  body: OperationResponse;
  freshEvents: DomainEvent[];
  freshOperation: boolean;
} {
  const envelope =
    'commands' in input
      ? batchEnvelopeSchema.parse(input)
      : commandEnvelopeSchema.parse(input);
  const hash = createHash('sha256').update(canonical(envelope)).digest('hex');
  return db.sqlite
    .transaction(() => {
      const gen = generation(db);
      if (envelope.generation !== gen)
        fail(
          'generation_changed',
          'База восстановлена. Получите новый снимок.',
          { generation: gen },
        );
      const old = db.orm
        .select()
        .from(schema.operations)
        .where(eq(schema.operations.id, envelope.operationId))
        .get();
      if (old) {
        if (old.actorId !== actor.id)
          fail(
            'forbidden',
            'Идентификатор операции принадлежит другому актору.',
          );
        if (old.commandHash !== hash)
          fail(
            'operation_mismatch',
            'Этот operationId уже использован для другого запроса.',
          );
        return {
          status: old.status,
          body: old.result,
          freshEvents: [],
          freshOperation: false,
        };
      }
      const now = options.now ?? new Date().toISOString();
      const commands: Command[] =
        'commands' in envelope
          ? envelope.commands
          : [
              commandSchema.parse({
                command: envelope.command,
                payload: envelope.payload,
              }),
            ];
      const previous = readState(db);
      let state = previous;
      const history = readEvents(db);
      const events: DomainEvent[] = [];
      const results: OperationSuccess['results'] = [];
      const start = latestSeq(db) + 1;
      let error: DomainError | undefined;
      for (const [index, command] of commands.entries())
        try {
          const applied = applyCommand(state, command, {
            now,
            ids: options.ids ?? randomUUID,
            actor,
            history: [...history, ...events],
            operationId: envelope.operationId,
            confirmOwnerFields: envelope.confirmOwnerFields === true,
          });
          state = applied.state;
          results.push(applied.result);
          for (const effect of applied.effects)
            events.push({
              ...effect,
              generation: gen,
              seq: start + events.length,
              at: now,
              actorId: actor.id,
              actorLabel: actor.label,
              operationId: envelope.operationId,
              firstSeq: start,
              lastSeq: start,
            });
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          error = e;
          if ('commands' in envelope) error.details.commandIndex = index;
          break;
        }
      if (error) {
        const body = {
          ...error.toJSON(),
          operationId: envelope.operationId,
          generation: gen,
        };
        if (!envelope.dryRun && error.code !== 'unavailable')
          db.orm
            .insert(schema.operations)
            .values({
              id: envelope.operationId,
              actorId: actor.id,
              actorLabel: actor.label,
              command: 'commands' in envelope ? 'batch' : envelope.command,
              commandHash: hash,
              status: error.status,
              result: body,
              firstSeq: null,
              lastSeq: null,
              createdAt: now,
            })
            .run();
        return {
          status: error.status,
          body,
          freshEvents: [],
          freshOperation: !envelope.dryRun && error.code !== 'unavailable',
        };
      }
      const firstSeq = events.length ? start : null,
        lastSeq = events.length ? start + events.length - 1 : null;
      for (const e of events) e.lastSeq = lastSeq!;
      const body: OperationSuccess = {
        ok: true,
        operationId: envelope.operationId,
        generation: gen,
        firstSeq: envelope.dryRun ? null : firstSeq,
        lastSeq: envelope.dryRun ? null : lastSeq,
        results,
        events: envelope.dryRun ? [] : events,
        ...(envelope.dryRun ? { dryRun: true } : {}),
      };
      if (!envelope.dryRun) {
        writeState(db, state, previous);
        for (const { generation: _generation, ...event } of events)
          db.orm.insert(schema.events).values(event).run();
        db.orm
          .insert(schema.operations)
          .values({
            id: envelope.operationId,
            actorId: actor.id,
            actorLabel: actor.label,
            command: 'commands' in envelope ? 'batch' : envelope.command,
            commandHash: hash,
            status: 200,
            result: body,
            firstSeq,
            lastSeq,
            createdAt: now,
          })
          .run();
      }
      return {
        status: 200,
        body,
        freshEvents: envelope.dryRun ? [] : events,
        freshOperation: !envelope.dryRun,
      };
    })
    .immediate();
}
