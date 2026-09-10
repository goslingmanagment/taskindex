import { ArgumentError } from './arguments.js';
import { exitCode } from './client.js';
import { withHints } from './errors.js';
import type { SavedOperation } from './outbox.js';
import type { Session } from './session.js';

function describe(operation: SavedOperation): Record<string, unknown> {
  const { envelope } = operation;
  return {
    operationId: envelope.operationId,
    generation: envelope.generation,
    endpoint: operation.endpoint,
    command: 'commands' in envelope ? 'batch' : envelope.command,
    ...('commands' in envelope ? { commands: envelope.commands.length } : {}),
    ...(envelope.dryRun !== undefined ? { dryRun: envelope.dryRun } : {}),
    ...(operation.savedAt ? { savedAt: operation.savedAt } : {}),
  };
}

// `operation list`: the local queue of this agent, including files set aside
// as `*.corrupt` by this or an earlier run, and envelopes of the old layout.
export async function runOperationList(session: Session): Promise<number> {
  const { outbox, state, identity, legacy, pending, skipped, emit } = session;
  const corrupt = [
    ...skipped.map((entry) => ({
      ...entry,
      file: entry.renamedTo ?? entry.file,
    })),
    ...(await outbox.corrupt())
      .filter((file) => !skipped.some((entry) => entry.renamedTo === file))
      .map((file) => ({
        file,
        reason: 'corrupt' as const,
        message: 'отложен предыдущим запуском',
      })),
  ];
  emit({
    ok: true,
    actorId: session.actorId,
    ...(identity ? { agentId: identity.agentId } : {}),
    directory: outbox.directory,
    pending: pending.map(describe),
    corrupt,
    ...(legacy.length
      ? { legacy: { directory: state.paths.legacyOps, files: legacy } }
      : {}),
  });
  return 0;
}

// `operation resume [ID]`: only this agent's envelopes; each is settled by
// its stored outcome first and resent only when the server has no record.
export async function runResume(
  session: Session,
  id?: string,
): Promise<number> {
  const { client, outbox, pending, emit } = session;
  const operations = id
    ? [pending.find((operation) => operation.envelope.operationId === id)]
    : pending;
  if (operations.some((operation) => !operation))
    throw new ArgumentError('Сохранённый конверт не найден');
  let code = 0;
  for (const operation of operations) {
    const reply = await client.resume(outbox, operation!);
    emit(withHints(reply.body));
    code = Math.max(code, exitCode(reply));
  }
  if (!operations.length) emit({ ok: true, resumed: 0 });
  return code;
}
