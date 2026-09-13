import { CLI_ERROR_CODES } from './errors.js';
import {
  GLOBAL_FLAGS,
  HELP_TEXT,
  PAGE_FLAGS,
  READS,
  SERVICE,
  UnknownCommand,
  WRITES,
  WRITE_FLAGS,
  commandName,
  groupActions,
  payloadFlags,
  type FlagSpec,
  type PositionalSpec,
  type ReadSpec,
  type ServiceSpec,
  type WriteSpec,
} from './spec.js';

// Help is JSON, like every other output, and is rendered from the
// specification only: a flag that is not in `spec.ts` does not exist.

function placeholder(entry: FlagSpec): string {
  if (entry.values) return entry.values.join('|');
  switch (entry.kind) {
    case 'boolean':
      return 'true|false';
    case 'number':
      return 'N';
    case 'json':
      return 'JSON';
    case 'list':
      return 'A,B';
    default: {
      const key = entry.key ?? entry.name;
      const identifier =
        key === 'id' ||
        key.endsWith('Id') ||
        entry.name.endsWith('-id') ||
        entry.description.startsWith('Устойчивый идентификатор');
      const base =
        key === 'due' || key === 'followUp' || key === 'follow-up'
          ? 'YYYY-MM-DD'
          : identifier
            ? 'ID'
            : key === 'cursor'
              ? 'CURSOR'
              : key === 'generation'
                ? 'G'
                : key === 'file'
                  ? 'PATH|-'
                  : 'TEXT';
      return entry.nullable ? `${base}|null` : base;
    }
  }
}

function typeLabel(entry: FlagSpec): string {
  if (entry.values) return entry.values.join('|');
  const base =
    entry.kind === 'number'
      ? 'integer'
      : entry.kind === 'boolean'
        ? 'boolean'
        : entry.kind === 'json'
          ? 'json'
          : entry.kind === 'list'
            ? 'list'
            : 'string';
  return entry.nullable ? `${base}|null` : base;
}

// A switch (`--all`, `--dry-run`) is shown bare; a boolean filter or field
// (`--archived true|false`, `--done true|false`) shows its values because the
// value carries meaning.
function flagUsage(entry: FlagSpec, bare = false): string {
  const text =
    entry.kind === 'boolean' && bare
      ? `--${entry.name}`
      : `--${entry.name} ${placeholder(entry)}`;
  return entry.required ? text : `[${text}]`;
}

const positionalUsage = (positional: PositionalSpec[] | undefined) =>
  (positional ?? [])
    .map((entry) => (entry.optional ? `[${entry.name}]` : entry.name))
    .join(' ');

function describeFlags(flags: FlagSpec[]) {
  return flags.map((entry) => ({
    flag: `--${entry.name}`,
    type: typeLabel(entry),
    ...(entry.required ? { required: true } : {}),
    description: entry.description,
  }));
}

const describePositional = (positional: PositionalSpec[] | undefined) =>
  (positional ?? []).map((entry) => ({
    name: entry.name,
    ...(entry.optional ? { optional: true } : {}),
    description: entry.description,
  }));

const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

export function readFlags(spec: ReadSpec): FlagSpec[] {
  return [
    ...spec.query,
    ...(spec.flags ?? []),
    ...(spec.pageable ? PAGE_FLAGS : []),
  ];
}

function readUsage(spec: ReadSpec): string {
  return join(
    `taskindex ${commandName(spec)}`,
    positionalUsage(spec.positional),
    ...spec.query.map((entry) => flagUsage(entry)),
    ...(spec.flags ?? []).map((entry) => flagUsage(entry, true)),
    ...(spec.pageable ? PAGE_FLAGS : []).map((entry) => flagUsage(entry, true)),
  );
}

function writeUsage(spec: WriteSpec): string {
  if (spec.command === 'batch')
    return 'taskindex batch --file PATH|- [--dry-run] [--operation-id ID] [--generation G]';
  const flags = payloadFlags(spec.command).filter(
    (entry) => !spec.positional.some((p) => p.key === entry.key),
  );
  const ordered = [
    ...flags.filter((entry) => entry.required),
    ...flags.filter((entry) => !entry.required),
  ];
  return join(
    `taskindex ${commandName(spec)}`,
    positionalUsage(spec.positional),
    ...ordered.map((entry) => flagUsage(entry)),
    '| --payload JSON | --file PATH|-',
  );
}

function serviceUsage(spec: ServiceSpec): string {
  return join(
    `taskindex ${commandName(spec)}`,
    positionalUsage(spec.positional),
    ...(spec.flags ?? []).map((entry) => flagUsage(entry, true)),
  );
}

function usageOf(spec: ReadSpec | WriteSpec | ServiceSpec): string {
  return READS.includes(spec as ReadSpec)
    ? readUsage(spec as ReadSpec)
    : WRITES.includes(spec as WriteSpec)
      ? writeUsage(spec as WriteSpec)
      : serviceUsage(spec as ServiceSpec);
}

const summaryLine = (spec: ReadSpec | WriteSpec | ServiceSpec) => ({
  command: commandName(spec),
  usage: usageOf(spec),
  summary: spec.summary,
});

const ERROR_CODES = [...CLI_ERROR_CODES];

function writeFlagsOf(spec: WriteSpec): FlagSpec[] {
  const command = spec.command;
  if (command === 'batch') return [];
  return payloadFlags(command).map((entry) => {
    const positional = spec.positional.find((p) => p.key === entry.key);
    return positional
      ? {
          ...entry,
          description: `${entry.description} (или позиционный ${positional.name})`,
        }
      : entry;
  });
}

function commandHelp(spec: ReadSpec | WriteSpec | ServiceSpec) {
  const isRead = READS.includes(spec as ReadSpec);
  const isWrite = WRITES.includes(spec as WriteSpec);
  const flags = isRead
    ? readFlags(spec as ReadSpec)
    : isWrite
      ? writeFlagsOf(spec as WriteSpec)
      : ((spec as ServiceSpec).flags ?? []);
  return {
    command: commandName(spec),
    usage: usageOf(spec),
    summary: spec.summary,
    positional: describePositional(spec.positional),
    flags: describeFlags(flags),
    globalFlags: describeFlags([
      ...(isWrite ? WRITE_FLAGS : []),
      ...GLOBAL_FLAGS,
    ]),
    example: spec.example,
    ...(isWrite ? { outcomes: HELP_TEXT.outcomes } : {}),
    exitCodes: HELP_TEXT.exitCodes,
    errorCodes: ERROR_CODES,
  };
}

function overview() {
  return {
    usage: HELP_TEXT.usage,
    reads: READS.map(summaryLine),
    writes: WRITES.map(summaryLine),
    service: SERVICE.map(summaryLine),
    globalFlags: describeFlags(GLOBAL_FLAGS),
    writeFlags: describeFlags(WRITE_FLAGS),
    pageFlags: describeFlags(PAGE_FLAGS),
    payloads: HELP_TEXT.payloads,
    configuration: HELP_TEXT.configuration,
    exitCodes: HELP_TEXT.exitCodes,
    errorCodes: ERROR_CODES,
    outcomes: HELP_TEXT.outcomes,
    next: 'taskindex help <group> [<action>]',
  };
}

// help                 → overview
// help <group>         → the command itself when the group has no actions,
//                        otherwise the list of its actions
// help <group> <action> → one command
export function renderHelp(group?: string, action?: string): unknown {
  if (!group) return overview();
  const actions = groupActions(group);
  if (!actions.length)
    throw new UnknownCommand(`Неизвестная команда: ${group}`, 'taskindex help');
  if (action !== undefined) {
    const exact = actions.find((spec) => spec.action === action);
    if (!exact)
      throw new UnknownCommand(
        `${group}: неизвестное действие ${action}; ожидается ${actions
          .map((spec) => spec.action ?? '(без действия)')
          .join('|')}`,
        `taskindex help ${group}`,
      );
    return commandHelp(exact);
  }
  if (actions.length === 1 && actions[0]!.action === undefined)
    return commandHelp(actions[0]!);
  return {
    group,
    actions: actions.map(summaryLine),
    next: `taskindex help ${group} <action>`,
  };
}
