import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readInput } from './input.js';
import {
  commandPayloadSchemas,
  batchEnvelopeSchema,
  commandEnvelopeSchema,
} from '../shared/schemas.js';
import type { CommandName } from '../shared/model.js';
import {
  ArgumentError,
  flagString,
  jsonObject,
  parseArguments,
  parseJson,
  required,
  type Arguments,
} from './arguments.js';
import { acknowledgeStored } from './acknowledge.js';
import { ApiClient, exitCode, type ApiReply } from './client.js';
import { configureLocale, formatIssues, withHints } from './errors.js';
import { renderHelp } from './help.js';
import {
  CorruptEnvelopeError,
  OUTBOX_FORMAT_VERSION,
  type Outbox,
  type SavedOperation,
  type SkippedFile,
} from './outbox.js';
import { readPath } from './reads.js';
import {
  GLOBAL_FLAGS,
  UnknownCommand,
  booleanFlagNames,
  commandName,
  resolveCommand,
  type ReadSpec,
  type Resolved,
  type WriteSpec,
} from './spec.js';
import { CliState, type Identity } from './state.js';
import { buildPayload, envelopeFlags } from './writes.js';

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readInput?: (path: string) => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Session {
  args: Arguments;
  client: ApiClient;
  state: CliState;
  identity?: Identity;
  outbox: Outbox;
  actorId: string;
  pending: SavedOperation[];
  skipped: SkippedFile[];
  legacy: string[];
  emit: (value: unknown) => void;
  warn: (value: unknown) => void;
  input: (path: string) => Promise<string>;
  options: CliOptions;
}

let switches: Set<string> | undefined;

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

async function runOperationList(session: Session): Promise<number> {
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

async function runResume(session: Session, id?: string): Promise<number> {
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

// Reads need the generation only for events without --generation; writes
// need it for the envelope. `/api/me` is the light request; a server whose
// `me` has no generation yet answers through `/api/context`.
async function currentGeneration(session: Session): Promise<ApiReply> {
  const me = await session.client.request('/api/me');
  if (exitCode(me) || typeof me.body.generation === 'string') return me;
  return session.client.request('/api/context');
}

// `--commit`: the cursor moves only when the read was complete — every page
// walked (`more: false`) — to the position the server reported for it.
async function commitRead(
  session: Session,
  spec: ReadSpec,
  body: Record<string, unknown>,
): Promise<void> {
  const { state, identity, warn } = session;
  const operations = body.operations as { more?: unknown } | undefined;
  const incomplete =
    spec.group === 'digest' ? operations?.more === true : body.more === true;
  if (incomplete) {
    warn({
      warning: 'cursor_not_committed',
      reason: 'more',
      message: 'Прочитаны не все страницы; курсор не сдвинут',
      next: `taskindex ${spec.group === 'digest' ? 'activity' : spec.group} --since last --all --commit`,
    });
    return;
  }
  const seq = typeof body.latestSeq === 'number' ? body.latestSeq : body.seq;
  if (typeof body.generation !== 'string' || typeof seq !== 'number') {
    warn({
      warning: 'cursor_not_committed',
      reason: 'response',
      message: 'В ответе нет generation или seq; курсор не сдвинут',
    });
    return;
  }
  const cursor = await state.commitCursor(identity, {
    generation: body.generation,
    seq,
    ...(typeof body.operationSeq === 'number'
      ? { operationSeq: body.operationSeq }
      : {}),
  });
  warn({ cursorCommitted: cursor, file: state.cursorFile(identity) });
}

// `--all` on a cursor-paginated read: pages are collected and printed only
// after a complete walk. A 409 conflict on the cursor (the list changed
// between pages) restarts the walk from the first page, at most three times;
// generation_changed is never retried. A walk whose first and last page carry
// a different `seq` is reported: only /api/snapshot is a consistent full list.
async function walkPages(
  session: Session,
  spec: ReadSpec,
  first: string,
): Promise<number> {
  const { args, client, options, emit, warn } = session;
  for (let attempt = 0; ; attempt += 1) {
    const pages: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let path = first;
    let failure: ApiReply | undefined;
    while (!options.signal?.aborted) {
      if (seen.has(path)) throw new Error('API повторил курсор страницы');
      seen.add(path);
      const reply = await client.request(path);
      if (exitCode(reply)) {
        failure = reply;
        break;
      }
      pages.push(reply.body);
      if (reply.body.more !== true) break;
      if (typeof reply.body.nextCursor !== 'string')
        throw new Error('API сообщил more без nextCursor');
      const next: URL = new URL(path, client.baseUrl);
      next.searchParams.set('cursor', reply.body.nextCursor);
      if (typeof reply.body.generation === 'string')
        next.searchParams.set('generation', reply.body.generation);
      path = `${next.pathname}${next.search}`;
    }
    if (failure) {
      if (failure.body.code === 'conflict' && pages.length && attempt < 3) {
        warn({ restart: attempt + 1, reason: 'cursor_conflict' });
        continue;
      }
      emit(withHints(failure.body));
      return exitCode(failure);
    }
    for (const body of pages) emit(body);
    const fromSeq = pages[0]?.seq;
    const toSeq = pages.at(-1)?.seq;
    if (
      typeof fromSeq === 'number' &&
      typeof toSeq === 'number' &&
      fromSeq !== toSeq
    )
      warn({ warning: 'list_changed_during_walk', fromSeq, toSeq });
    const last = pages.at(-1);
    if (args.flags.commit && last) await commitRead(session, spec, last);
    return 0;
  }
}

async function runRead(
  session: Session,
  spec: ReadSpec,
  rest: string[],
): Promise<number> {
  const { args, client, options, emit, outbox, pending } = session;
  const flags = { ...args.flags };
  const isEvents = spec.group === 'events';
  // `--since last` reads the committed cursor; without one the read starts at
  // 0 under the server's current generation, which loses nothing.
  if (flags.since === 'last') {
    const cursor = await session.state.readCursor(session.identity);
    flags.since = String(cursor?.seq ?? 0);
    if (cursor) flags.generation ??= cursor.generation;
  } else if (flags.since !== undefined && !/^\d+$/.test(String(flags.since)))
    throw new ArgumentError(
      '--since: ожидается число или last',
      `taskindex help ${spec.group}`,
    );
  else if (Number(flags.since ?? 0) > 0 && !flags.generation)
    throw new ArgumentError(
      'Для --since после первого события нужен --generation исходного курсора',
      'используйте --since last или передайте --generation',
    );
  if ((isEvents || args.flags.since === 'last') && !flags.generation) {
    const source = await currentGeneration(session);
    if (exitCode(source)) {
      emit(withHints(source.body));
      return exitCode(source);
    }
    flags.generation = required(
      typeof source.body.generation === 'string'
        ? source.body.generation
        : undefined,
      'generation в ответе сервера',
    );
  }
  let path = readPath(spec, rest, flags);
  if (args.flags.all && spec.pageable) return walkPages(session, spec, path);
  const intervalFlag = flagString(args.flags, 'interval');
  if (intervalFlag !== undefined && !/^\d+$/.test(intervalFlag))
    throw new ArgumentError('--interval: ожидается число миллисекунд');
  const interval = Math.max(250, Number(intervalFlag ?? 1000));
  const id = rest[0];
  const isOperationGet = spec.group === 'operation' && spec.action === 'get';
  let result: ApiReply;
  const seen = new Set<string>();
  do {
    if (seen.has(path) && !args.flags.follow)
      throw new Error('API повторил курсор страницы');
    seen.add(path);
    try {
      result = await client.request(path);
    } catch (error) {
      if (!isOperationGet || !id) throw error;
      emit({
        ok: false,
        code: 'network_error',
        retryable: true,
        status: 'unknown',
        operationId: id,
        message: 'Не удалось выяснить исход операции',
      });
      return 1;
    }
    if (isOperationGet && id) {
      // The same rule as send/resume decides whether the held envelope is settled.
      const held = pending.find(
        (operation) => operation.envelope.operationId === id,
      );
      const settled =
        held && acknowledgeStored(result, held.envelope).acknowledgement;
      if (settled?.kind === 'confirmed' || settled?.kind === 'rejected')
        await outbox.remove(id);
    }
    if (spec.group === 'export' && args.flags.out && exitCode(result) === 0) {
      const destination = required(flagString(args.flags, 'out'), '--out');
      await writeFile(
        destination,
        `${JSON.stringify(result.body, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      emit({
        ok: true,
        path: destination,
        generation: result.body.generation,
        seq: result.body.seq,
      });
    } else if (
      isEvents &&
      args.flags.follow &&
      exitCode(result) === 0 &&
      Array.isArray(result.body.events) &&
      !result.body.events.length
    ) {
      // Polling: an empty page is noise for an agent; only pages with
      // events (and every error) are printed.
    } else emit(exitCode(result) ? withHints(result.body) : result.body);
    if (exitCode(result)) return exitCode(result);
    if (isEvents && (args.flags.follow || args.flags.all)) {
      const events = result.body.events as { seq: number }[] | undefined;
      const cursor = events?.at(-1)?.seq;
      if (cursor !== undefined) {
        const next: URL = new URL(path, client.baseUrl);
        next.searchParams.set('since', String(cursor));
        path = `${next.pathname}${next.search}`;
      }
      if (result.body.more === true) continue;
      // Every event up to latestSeq has been printed: a complete read.
      if (args.flags.commit) await commitRead(session, spec, result.body);
      if (!args.flags.follow || options.signal?.aborted) break;
      await (
        options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(interval);
      if (options.signal?.aborted) break;
      continue;
    }
    break;
  } while (!options.signal?.aborted);
  if (args.flags.commit && !(isEvents && (args.flags.follow || args.flags.all)))
    await commitRead(session, spec, result.body);
  return 0;
}

async function runWrite(
  session: Session,
  spec: WriteSpec,
  rest: string[],
): Promise<number> {
  const { args, client, outbox, actorId, input, emit } = session;
  const operationId = flagString(args.flags, 'operation-id') ?? randomUUID();
  outbox.path(operationId);
  let endpoint: SavedOperation['endpoint'] = '/api/commands';
  let command: CommandName | undefined;
  let payload: Record<string, unknown> | undefined;
  let commands: unknown[] | undefined;
  if (spec.command === 'batch') {
    endpoint = '/api/commands/batch';
    const file = required(flagString(args.flags, 'file'), '--file');
    const parsed = parseJson(await input(file), file);
    const list = Array.isArray(parsed) ? parsed : jsonObject(parsed).commands;
    if (!Array.isArray(list))
      throw new ArgumentError(
        'Файл пакета должен содержать массив команд или {commands: [...]}',
      );
    commands = list;
  } else {
    command = spec.command;
    const raw = await buildPayload(
      spec as WriteSpec & { command: CommandName },
      rest,
      args,
      input,
    );
    const validation = commandPayloadSchemas[command].safeParse(raw);
    if (!validation.success) {
      emit({
        ok: false,
        code: 'invalid_arguments',
        message: `Проверьте поля команды ${command}`,
        issues: formatIssues(validation.error.issues),
        hint: `taskindex help ${spec.group} ${spec.action ?? ''}`.trim(),
      });
      return 2;
    }
    payload = validation.data as Record<string, unknown>;
  }
  const saved = await outbox.get(operationId);
  let generation =
    flagString(args.flags, 'generation') ?? saved?.envelope.generation;
  if (!generation) {
    const source = await currentGeneration(session);
    if (exitCode(source)) {
      emit(source.body);
      return exitCode(source);
    }
    generation = required(
      typeof source.body.generation === 'string'
        ? source.body.generation
        : undefined,
      'generation в ответе сервера',
    );
  }
  const envelope = {
    operationId,
    generation,
    ...envelopeFlags(args),
    ...(commands ? { commands } : { command, payload }),
  };
  const parsedEnvelope = (
    commands ? batchEnvelopeSchema : commandEnvelopeSchema
  ).safeParse(envelope);
  if (!parsedEnvelope.success) {
    emit({
      ok: false,
      code: 'invalid_arguments',
      message: 'Проверьте конверт операции',
      issues: formatIssues(parsedEnvelope.error.issues),
    });
    return 2;
  }
  const reply = await client.send(outbox, {
    formatVersion: OUTBOX_FORMAT_VERSION,
    baseUrl: client.baseUrl,
    endpoint,
    actorId,
    savedAt: saved?.savedAt ?? new Date().toISOString(),
    envelope: parsedEnvelope.data,
  });
  emit(withHints(reply.body));
  return exitCode(reply);
}

async function openSession(
  args: Arguments,
  options: CliOptions,
  emit: Session['emit'],
  warn: Session['warn'],
): Promise<Session> {
  const env = options.env ?? process.env;
  const token = required(env.TASKINDEX_TOKEN, 'TASKINDEX_TOKEN');
  const client = new ApiClient({
    baseUrl: required(env.TASKINDEX_URL, 'TASKINDEX_URL'),
    token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  // State is kept per server and per agent: the identity comes from the key
  // (GET /api/me, cached by the key hash), so two agents on one machine never
  // see or resend each other's envelopes.
  const state = new CliState(env, client.baseUrl, token);
  const legacy = await state.legacyPending();
  if (legacy.length)
    warn({
      warning: 'legacy_outbox',
      directory: state.paths.legacyOps,
      files: legacy,
      next: 'taskindex operation get <id>, затем удалить файл вручную',
    });
  const { identity, warning } = await state.identify(() =>
    client.request('/api/me'),
  );
  if (warning) warn(warning);
  const listed = await state.pending(identity);
  for (const skipped of listed.skipped)
    warn({ warning: 'outbox_skipped', ...skipped });
  if (listed.operations.length)
    warn({
      pendingOperations: listed.operations.map(
        (operation) => operation.envelope.operationId,
      ),
      next: 'taskindex operation get <id> или operation resume <id>',
    });
  return {
    args,
    client,
    state,
    identity,
    outbox: state.outbox(identity),
    actorId: state.actorId(identity),
    pending: listed.operations,
    skipped: listed.skipped,
    legacy,
    emit,
    warn,
    input: options.readInput ?? readInput,
    options,
  };
}

async function runCursor(
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
  let generation = flagString(args.flags, 'generation');
  if (!generation) {
    const source = await currentGeneration(session);
    if (exitCode(source)) {
      emit(withHints(source.body));
      return exitCode(source);
    }
    generation = required(
      typeof source.body.generation === 'string'
        ? source.body.generation
        : undefined,
      'generation в ответе сервера',
    );
  }
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
