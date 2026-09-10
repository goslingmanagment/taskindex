import { ArgumentError, parseArguments } from './arguments.js';
import { exitCode } from './client.js';
import { runCursor } from './cursor.js';
import { configureLocale, withHints } from './errors.js';
import { renderHelp } from './help.js';
import { runOperationList, runResume } from './operations.js';
import { CorruptEnvelopeError } from './outbox.js';
import { runRead } from './reads.js';
import {
  ReplyExit,
  openSession,
  type CliOptions,
  type Session,
} from './session.js';
import {
  GLOBAL_FLAGS,
  UnknownCommand,
  booleanFlagNames,
  commandName,
  resolveCommand,
  type Resolved,
} from './spec.js';
import { runWrite } from './writes.js';

let switches: Set<string> | undefined;

// help | read | write | operation list/resume | cursor: every command is
// resolved from the specification before anything touches the network.
async function dispatch(target: Resolved, session: Session): Promise<number> {
  switch (target.kind) {
    case 'read':
      return runRead(session, target.spec, target.rest);
    case 'write':
      return runWrite(session, target.spec, target.rest);
    case 'service': {
      const { group, action } = target.spec;
      const known = [...(target.spec.flags ?? []), ...GLOBAL_FLAGS];
      for (const name of Object.keys(session.args.flags))
        if (!known.some((entry) => entry.name === name))
          throw new ArgumentError(
            `Флаг --${name} не поддерживается командой ${commandName(target.spec)}`,
            `taskindex help ${commandName(target.spec)}`,
          );
      if (group === 'operation' && action === 'list')
        return runOperationList(session);
      if (group === 'operation' && action === 'resume')
        return runResume(session, target.rest[0]);
      if (group === 'cursor') return runCursor(session, action, target.rest);
      throw new ArgumentError(
        `Команда ${group} не реализована`,
        'taskindex help',
      );
    }
  }
}

export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const output =
    options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const diagnostic =
    options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (value: unknown) => output(JSON.stringify(value));
  const warn = (value: unknown) => diagnostic(JSON.stringify(value));
  try {
    configureLocale();
    switches ??= booleanFlagNames();
    const args = parseArguments(argv, switches);
    const [group, ...rest] = args.positional;
    if (!group || group === 'help') {
      emit(renderHelp(rest[0], rest[1]));
      return 0;
    }
    const target = resolveCommand(args.positional);
    if (args.flags.help) {
      emit(renderHelp(target.spec.group, target.spec.action));
      return 0;
    }
    const session = await openSession(args, options, emit, warn);
    return await dispatch(target, session);
  } catch (error) {
    if (error instanceof ReplyExit) {
      emit(withHints(error.reply.body));
      return exitCode(error.reply);
    }
    const argument =
      error instanceof ArgumentError || error instanceof UnknownCommand;
    emit({
      ok: false,
      code: argument ? 'invalid_arguments' : 'client_error',
      message: error instanceof Error ? error.message : 'Ошибка CLI',
      ...(argument && error.hint ? { hint: error.hint } : {}),
      ...(error instanceof CorruptEnvelopeError ? error.skipped : {}),
    });
    return argument ? 2 : 1;
  }
}
