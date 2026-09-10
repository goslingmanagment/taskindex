import {
  ArgumentError,
  flagBoolean,
  flagString,
  jsonObject,
  parseJson,
  type Arguments,
} from './arguments.js';
import {
  GLOBAL_FLAGS,
  WRITE_FLAGS,
  commandName,
  payloadFlags,
  type FlagSpec,
  type WriteSpec,
} from './spec.js';
import type { CommandName } from '../shared/model.js';

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
export async function buildPayload(
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

export function dryRunOf(args: Arguments): boolean | undefined {
  return flagBoolean(args.flags, 'dry-run');
}
