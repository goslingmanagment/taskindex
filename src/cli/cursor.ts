import { ArgumentError, flagString, required } from './arguments.js';
import { currentGeneration, type Session } from './session.js';

// `cursor show|commit SEQ|reset`: the committed read position of this agent
// on this server. A read never moves it on its own; `--commit` on
// digest/activity/events or an explicit `cursor commit` does.
export async function runCursor(
  session: Session,
  action: string | undefined,
  rest: string[],
): Promise<number> {
  const { state, identity, args, emit } = session;
  const file = state.cursorFile(identity);
  if (action === 'show') {
    emit({
      ok: true,
      cursor: (await state.readCursor(identity)) ?? null,
      file,
    });
    return 0;
  }
  if (action === 'reset') {
    await state.resetCursor(identity);
    emit({ ok: true, cursor: null, file });
    return 0;
  }
  const help = 'taskindex help cursor commit';
  const seq = required(rest[0], 'SEQ');
  if (!/^\d+$/.test(seq)) throw new ArgumentError('SEQ: ожидается число', help);
  const operationSeq = flagString(args.flags, 'operation-seq');
  if (operationSeq !== undefined && !/^\d+$/.test(operationSeq))
    throw new ArgumentError('--operation-seq: ожидается число', help);
  const generation =
    flagString(args.flags, 'generation') ?? (await currentGeneration(session));
  const cursor = await state.commitCursor(identity, {
    generation,
    seq: Number(seq),
    ...(operationSeq !== undefined
      ? { operationSeq: Number(operationSeq) }
      : {}),
  });
  emit({ ok: true, cursor, file });
  return 0;
}
