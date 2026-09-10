import { randomUUID } from 'node:crypto';
import {
  ArgumentError,
  flagBoolean,
  flagString,
  jsonObject,
  parseJson,
  required,
  type Arguments,
} from './arguments.js';
import { exitCode } from './client.js';
import { formatIssues, withHints } from './errors.js';
import { OUTBOX_FORMAT_VERSION, type SavedOperation } from './outbox.js';
import { currentGeneration, type Session } from './session.js';
import {
  GLOBAL_FLAGS,
  WRITE_FLAGS,
  commandName,
  payloadFlags,
  type FlagSpec,
  type WriteSpec,
} from './spec.js';
import type { CommandName } from '../shared/model.js';
import {
  commandPayloadSchemas,
  operationEnvelopeSchema,
} from '../shared/schemas.js';

function setField(
  payload: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (Object.hasOwn(payload, key) && payload[key] !== value)
    throw new ArgumentError(`Поле ${key} задано дважды`);
  payload[key] = value;
}

function convert(entry: FlagSpec, value: string | boolean): unknown {
  switch (entry.kind) {
    case 'json':
      return parseJson(String(value), `--${entry.name}`);
    case 'boolean':
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new ArgumentError(`--${entry.name}: ожидается true или false`);
    case 'number':
      if (!/^-?\d+(\.\d+)?$/.test(String(value)))
        throw new ArgumentError(`--${entry.name}: ожидается число`);
      return Number(value);
    default:
      return entry.nullable && value === 'null' ? null : value;
  }
}

// The payload of a write: --payload/--file first, then flags typed by the
// command's schema, then positional arguments. Unknown flags are argument
// errors, never silently forwarded.
async function buildPayload(
  spec: WriteSpec & { command: CommandName },
  rest: string[],
  args: Arguments,
  input: (path: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const help = `taskindex help ${commandName(spec)}`;
  const file = flagString(args.flags, 'file');
  const inline = flagString(args.flags, 'payload');
  if (file && inline)
    throw new ArgumentError('Используйте один из --file и --payload', help);
  const payload = file
    ? jsonObject(parseJson(await input(file), file))
    : inline
      ? jsonObject(parseJson(inline))
      : {};
  const reserved = new Set(
    [...WRITE_FLAGS, ...GLOBAL_FLAGS].map((entry) => entry.name),
  );
  const flags = payloadFlags(spec.command);
  for (const [name, value] of Object.entries(args.flags)) {
    if (reserved.has(name)) continue;
    const entry = flags.find((candidate) => candidate.name === name);
    if (!entry)
      throw new ArgumentError(
        `Флаг --${name} не поддерживается командой ${commandName(spec)}`,
        help,
      );
    setField(payload, entry.key ?? name, convert(entry, value));
  }
  const positional = [...rest];
  for (const argument of spec.positional) {
    const value = positional.shift();
    if (value === undefined) {
      if (!argument.optional)
        throw new ArgumentError(`Не задан ${argument.name}`, help);
      continue;
    }
    if (argument.kind === 'number') {
      if (!/^\d+$/.test(value))
        throw new ArgumentError(`${argument.name}: ожидается число`, help);
      setField(payload, argument.key, Number(value));
    } else setField(payload, argument.key, value);
  }
  if (positional.length)
    throw new ArgumentError(`Лишний аргумент: ${positional[0]}`, help);
  return payload;
}

function dryRunOf(args: Arguments): boolean | undefined {
  return flagBoolean(args.flags, 'dry-run');
}

// Envelope-level fields besides the payload: present only when given, so
// the envelope of a plain command stays byte-for-byte what it was.
function envelopeFlags(args: Arguments): {
  dryRun?: boolean;
  confirmOwnerFields?: boolean;
} {
  const dryRun = dryRunOf(args);
  const confirmOwnerFields = flagBoolean(args.flags, 'confirm-owner-fields');
  return {
    ...(dryRun !== undefined ? { dryRun } : {}),
    ...(confirmOwnerFields !== undefined ? { confirmOwnerFields } : {}),
  };
}

async function batchCommands(session: Session): Promise<unknown[]> {
  const file = required(flagString(session.args.flags, 'file'), '--file');
  const parsed = parseJson(await session.input(file), file);
  const list = Array.isArray(parsed) ? parsed : jsonObject(parsed).commands;
  if (!Array.isArray(list))
    throw new ArgumentError(
      'Файл пакета должен содержать массив команд или {commands: [...]}',
    );
  return list;
}

// One write: the payload is validated locally (Russian issues with hints),
// the envelope is saved to the outbox before the first attempt and settled
// by `ApiClient.send`. A saved envelope with the same operationId keeps its
// generation, so a retry is the same operation.
export async function runWrite(
  session: Session,
  spec: WriteSpec,
  rest: string[],
): Promise<number> {
  const { args, client, outbox, actorId, input, emit } = session;
  const operationId = flagString(args.flags, 'operation-id') ?? randomUUID();
  outbox.path(operationId);
  const batch = spec.command === 'batch';
  const endpoint: SavedOperation['endpoint'] = batch
    ? '/api/commands/batch'
    : '/api/commands';
  let body: Record<string, unknown>;
  if (spec.command === 'batch')
    body = { commands: await batchCommands(session) };
  else {
    const command: CommandName = spec.command;
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
        hint: `taskindex help ${commandName(spec)}`,
      });
      return 2;
    }
    body = { command, payload: validation.data };
  }
  const saved = await outbox.get(operationId);
  const generation =
    flagString(args.flags, 'generation') ??
    saved?.envelope.generation ??
    (await currentGeneration(session));
  const envelope = {
    operationId,
    generation,
    ...envelopeFlags(args),
    ...body,
  };
  const parsedEnvelope = operationEnvelopeSchema.safeParse(envelope);
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
