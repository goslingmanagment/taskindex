import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { applyCommand } from '../shared/commands.js';
import { canonicalJson } from '../shared/canonical-json.js';
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
  WorkspaceState,
} from '../shared/model.js';
import type { DatabaseHandle } from './db.js';
import {
  withWrite,
  withEvents,
  withoutEvents,
  readEventsForOperation,
  generation,
  getSetting,
  latestOperationSeq,
  latestSeq,
  readState,
  serverHistory,
  touchedByEvents,
  writeState,
} from './db.js';
import * as schema from './schema.js';
import type { Projection } from './projection.js';
export function executeOperation(
  db: DatabaseHandle,
  input: OperationEnvelope,
  actor: Actor,
  options: { now?: string; ids?: () => string; projection?: Projection } = {},
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
  const hash = createHash('sha256')
    .update(canonicalJson(envelope))
    .digest('hex');
  // The state written by this operation and the version it was written at,
  // handed to the projection once the transaction has committed.
  let committed: { state: WorkspaceState; version: string } | undefined;
  const outcome = withWrite(db, () => {
    const gen = generation(db);
    if (envelope.generation !== gen)
      fail('generation_changed', 'База восстановлена. Получите новый снимок.', {
        generation: gen,
      });
    const old = db.orm
      .select()
      .from(schema.operations)
      .where(eq(schema.operations.id, envelope.operationId))
      .get();
    if (old) {
      if (old.actorId !== actor.id)
        fail('forbidden', 'Идентификатор операции принадлежит другому актору.');
      if (old.commandHash !== hash)
        fail(
          'operation_mismatch',
          'Этот operationId уже использован для другого запроса.',
        );
      return {
        status: old.status,
        // A success stored without its events (Ж1) gets them back from the
        // journal, so the repeat answers exactly the first envelope.
        body: withEvents(old.result, readEventsForOperation(db, old.id)),
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
    const previous = options.projection?.read() ?? readState(db);
    // The owner's «today» for proposal.deliver, the same setting the read
    // routes use.
    const timezone = getSetting(db, 'timezone') ?? 'Europe/Moscow';
    let state = previous;
    const events: DomainEvent[] = [];
    // The reducer asks the journal only for what it needs (plan 01, step 2):
    // indexed reads plus the events of this packet so far.
    const history = serverHistory(db, events);
    const results: OperationSuccess['results'] = [];
    const start = latestSeq(db) + 1;
    // The journal position is taken inside the same immediate transaction as
    // the result, so it is dense and ordered even for operations without
    // events (no-op, stored rejection).
    const stored = {
      id: envelope.operationId,
      operationSeq: latestOperationSeq(db) + 1,
      actorId: actor.id,
      actorLabel: actor.label,
      command: 'commands' in envelope ? ('batch' as const) : envelope.command,
      commandHash: hash,
      createdAt: now,
    };
    let failure: DomainError | undefined;
    for (const [index, command] of commands.entries())
      try {
        const applied = applyCommand(state, command, {
          now,
          ids: options.ids ?? randomUUID,
          actor,
          history,
          operationId: envelope.operationId,
          confirmOwnerFields: envelope.confirmOwnerFields === true,
          timezone,
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
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        failure = error;
        if ('commands' in envelope) failure.details.commandIndex = index;
        break;
      }
    if (failure) {
      const body = {
        ...failure.toJSON(),
        operationId: envelope.operationId,
        generation: gen,
      };
      if (!envelope.dryRun && failure.code !== 'unavailable')
        db.orm
          .insert(schema.operations)
          .values({
            ...stored,
            status: failure.status,
            result: body,
            firstSeq: null,
            lastSeq: null,
          })
          .run();
      return {
        status: failure.status,
        body,
        freshEvents: [],
        freshOperation: !envelope.dryRun && failure.code !== 'unavailable',
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
      writeState(db, state, previous, touchedByEvents(events));
      for (const { generation: _generation, ...event } of events)
        db.orm.insert(schema.events).values(event).run();
      db.orm
        .insert(schema.operations)
        .values({
          ...stored,
          status: 200,
          result: withoutEvents(body),
          firstSeq,
          lastSeq,
        })
        .run();
      if (options.projection)
        committed = { state, version: options.projection.version() };
    }
    return {
      status: 200,
      body,
      freshEvents: envelope.dryRun ? [] : events,
      freshOperation: !envelope.dryRun,
    };
  });
  if (committed)
    options.projection?.replace(committed.state, committed.version);
  return outcome;
}
