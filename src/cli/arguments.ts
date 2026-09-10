export class ArgumentError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export interface Arguments {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Boolean flags of the administrative CLI; `taskindex` derives its own set
// from the command specification (`booleanFlagNames` in spec.ts).
export const ADMIN_SWITCHES: ReadonlySet<string> = new Set(['help', 'replace']);

// `switches` may omit their value (`--all`) or take `true|false`; every other
// flag requires a value.
export function parseArguments(
  argv: string[],
  switches: ReadonlySet<string> = ADMIN_SWITCHES,
): Arguments {
  const positional: string[] = [];
  const flags: Arguments['flags'] = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const normalized =
      token === '-q' ? '--q' : token === '-h' ? '--help' : token;
    if (!normalized.startsWith('--'))
      throw new ArgumentError(`Неизвестный флаг: ${token}`);
    const [name, ...inline] = normalized.slice(2).split('=');
    if (!name || Object.hasOwn(flags, name))
      throw new ArgumentError(`Повторный или пустой флаг: ${token}`);
    // Output is always JSON; the flag was a no-op and is gone (TI-033).
    if (name === 'json')
      throw new ArgumentError(
        'Флаг --json удалён',
        'вывод всегда JSON, флаг удалён',
      );
    if (inline.length) {
      const value = inline.join('=');
      if (switches.has(name)) {
        if (value !== 'true' && value !== 'false')
          throw new ArgumentError(`--${name}: ожидается true или false`);
        flags[name] = value === 'true';
      } else flags[name] = value;
    } else if (switches.has(name)) {
      const next = argv[index + 1];
      if (next === 'true' || next === 'false')
        flags[name] = argv[++index] === 'true';
      else flags[name] = true;
    } else {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--'))
        throw new ArgumentError(`Нужно значение --${name}`);
      flags[name] = next;
    }
  }
  return { positional, flags };
}

export function flagString(
  flags: Arguments['flags'],
  key: string,
): string | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new ArgumentError(`--${key} требует значение`);
  return value;
}

export function flagBoolean(
  flags: Arguments['flags'],
  key: string,
): boolean | undefined {
  const value = flags[key];
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ArgumentError(`--${key}: ожидается true или false`);
}

export function parseJson(value: string, source = 'JSON'): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ArgumentError(`${source}: неверный JSON`);
  }
}

export function jsonObject(
  value: unknown,
  source = 'payload',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ArgumentError(`${source}: ожидается JSON-объект`);
  return value as Record<string, unknown>;
}

export function required(value: string | undefined, name: string): string {
  if (!value) throw new ArgumentError(`Не задан ${name}`);
  return value;
}
