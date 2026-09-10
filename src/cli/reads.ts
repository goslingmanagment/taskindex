import { ArgumentError, required, type Arguments } from './arguments.js';
import { readFlags } from './help.js';
import {
  GLOBAL_FLAGS,
  PAGE_FLAGS,
  commandName,
  type ReadSpec,
} from './spec.js';

const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

// The request path of a read: positional arguments fill the route, query
// flags become parameters, anything the specification does not list is an
// argument error that names the command's help page.
export function readPath(
  spec: ReadSpec,
  rest: string[],
  flags: Arguments['flags'],
): string {
  const help = `taskindex help ${commandName(spec)}`;
  const known = [...readFlags(spec), ...GLOBAL_FLAGS];
  for (const name of Object.keys(flags))
    if (!known.some((entry) => entry.name === name))
      throw new ArgumentError(
        `Флаг --${name} не поддерживается командой ${commandName(spec)}`,
        help,
      );
  const params = new URLSearchParams();
  for (const entry of [...spec.query, ...(spec.pageable ? PAGE_FLAGS : [])]) {
    if (entry.name === 'all') continue;
    const value = flags[entry.name];
    if (value === undefined) {
      if (entry.required)
        throw new ArgumentError(`Нужен --${entry.name}`, help);
      continue;
    }
    if (entry.kind === 'number' && !/^\d+$/.test(String(value)))
      throw new ArgumentError(`--${entry.name}: ожидается число`, help);
    params.set(entry.key ?? camel(entry.name), String(value));
  }
  let path = spec.route;
  const positional = [...rest];
  for (const argument of spec.positional ?? [])
    path = path.replace(
      `{${argument.key}}`,
      encodeURIComponent(required(positional.shift(), argument.name)),
    );
  if (positional.length)
    throw new ArgumentError(`Лишний аргумент: ${positional[0]}`, help);
  return `${path}${params.size ? `?${params}` : ''}`;
}
