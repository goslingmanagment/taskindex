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
  flagBoolean,
  flagString,
  jsonObject,
  parseArguments,
  parseJson,
  required,
  type Arguments,
} from './arguments.js';
import { acknowledgeStored } from './acknowledge.js';
import { ApiClient, exitCode, type ApiReply } from './client.js';
import {
  CorruptEnvelopeError,
  OUTBOX_FORMAT_VERSION,
  type SavedOperation,
} from './outbox.js';
import { CliState } from './state.js';

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

export const HELP = {
  usage: 'taskindex <command> [--payload JSON | --file file.json] [flags]',
  reads: [
    'context',
    'snapshot',
    'tasks',
    'task get <id>',
    'task history <id>',
    'task find-origin --system S --ref R',
    'project list',
    'comment list <taskId>',
    'activity',
    'digest',
    'focus',
    'events --since N --generation G [--follow [--interval MS]] (--follow печатает только страницы с событиями; интервал по умолчанию 1000 мс, минимум 250)',
    'operation get <id>',
    'operation list (локальная очередь этого агента: ожидающие и повреждённые конверты)',
    'export [--out file.json]',
  ],
  writes: [
    'task create|sync|update|save|move|archive|restore|focus [id]',
    'project create|update [id]',
    'checklist add|update|remove|reorder <taskId> [itemId]',
    'comment add <taskId> --text TEXT',
    'comment remove <commentId>',
    'undo <seq> | --operation ID',
    'batch --file commands.json',
    'operation resume [operationId]',
  ],
  flags: [
    '--dry-run',
    '--operation-id ID',
    '--base-revision N',
    '--generation ID',
    '--payload JSON',
    '--file PATH|-',
    '--all (все страницы reads)',
    '--limit N',
    '--cursor CURSOR',
  ],
  payloads:
    'Поля команды задаются JSON или флагами --project-id, --waiting-for, --follow-up. --origin, --fields, --checklist, --position, --item-ids принимают JSON. null очищает --due, --follow-up и --project-id. Полные схемы: taskindex context.',
  configuration: [
    'TASKINDEX_URL',
    'TASKINDEX_TOKEN (через op)',
    'XDG_STATE_HOME (по умолчанию ~/.local/state); конверты: $XDG_STATE_HOME/taskindex/servers/<server>/agents/<agent>/ops',
  ],
  exitCodes: {
    success: 0,
    serverOrNetwork: 1,
    arguments: 2,
    conflict: 3,
    authorization: 4,
  },
  outcomes: [
    'успех (ok: true, тот же operationId и generation) → код 0, конверт удалён',
    'окончательный отказ (ok: false, retryable: false; conflict/operation_mismatch/generation_changed/not_undoable → 3, unauthorized/forbidden → 4, иначе 1) → конверт удалён',
    'повторяемый отказ или сеть (retryable: true, 5xx, обрыв) → код 1, status: unknown, конверт сохранён',
    'неподтверждённый ответ (2xx без результата операции, чужой operationId/generation, не JSON) → код 1, code: invalid_response, status: unknown, конверт сохранён; далее operation get <id>',
  ],
};

const controls = new Set([
  'dry-run',
  'operation-id',
  'base-revision',
  'generation',
  'payload',
  'file',
  'all',
  'follow',
  'help',
  'out',
  'operation',
  'interval',
]);
const jsonFlags = new Set([
  'origin',
  'fields',
  'checklist',
  'position',
  'item-ids',
]);
const booleanFlags = new Set(['focus', 'done', 'archived']);

async function payloadFromFlags(
  args: Arguments,
  input: (path: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const file = flagString(args.flags, 'file');
  const payload = flagString(args.flags, 'payload');
  if (file && payload)
    throw new ArgumentError('Используйте один из --file и --payload');
  const result = file
    ? jsonObject(parseJson(await input(file), file))
    : payload
      ? jsonObject(parseJson(payload))
      : {};
  for (const [key, value] of Object.entries(args.flags)) {
    if (controls.has(key)) continue;
    const name = key.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (Object.hasOwn(result, name))
      throw new ArgumentError(`Поле ${name} задано дважды`);
    if (jsonFlags.has(key)) result[name] = parseJson(String(value), `--${key}`);
    else if (booleanFlags.has(key)) result[name] = flagBoolean(args.flags, key);
    else if (
      ['due', 'follow-up', 'project-id'].includes(key) &&
      value === 'null'
    )
      result[name] = null;
    else result[name] = value;
  }
  const baseRevision = flagString(args.flags, 'base-revision');
  if (baseRevision !== undefined) {
    if (result.baseRevision !== undefined)
      throw new ArgumentError('baseRevision задан дважды');
    result.baseRevision = Number(baseRevision);
  }
  return result;
}

function setPositional(
  payload: Record<string, unknown>,
  key: string,
  value?: string,
): void {
  if (value === undefined) return;
  if (payload[key] !== undefined && payload[key] !== value)
    throw new ArgumentError(`${key} задан дважды`);
  payload[key] = value;
}

function query(
  path: string,
  flags: Arguments['flags'],
  allowed: string[],
): string {
  const supported = new Set([...allowed, 'all', 'follow', 'help']);
  for (const name of Object.keys(flags))
    if (!supported.has(name))
      throw new ArgumentError(`Флаг --${name} не поддерживается этим запросом`);
  const params = new URLSearchParams();
  for (const name of allowed)
    if (flags[name] !== undefined) params.set(name, String(flags[name]));
  return `${path}${params.size ? `?${params}` : ''}`;
}

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
  const input = options.readInput ?? readInput;
  try {
    const args = parseArguments(argv);
    if (args.flags.help || !args.positional.length) {
      emit(HELP);
      return 0;
    }
    const env = options.env ?? process.env;
    const token = required(env.TASKINDEX_TOKEN, 'TASKINDEX_TOKEN');
    const client = new ApiClient({
      baseUrl: required(env.TASKINDEX_URL, 'TASKINDEX_URL'),
      token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const [group, action, id, itemId] = args.positional;
    if (
      args.flags.since !== undefined &&
      Number(args.flags.since) > 0 &&
      !args.flags.generation
    )
      throw new ArgumentError(
        'Для --since после первого события нужен --generation исходного курсора',
      );

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
    const outbox = state.outbox(identity);
    const actorId = state.actorId(identity);
    const listed = await state.pending(identity);
    for (const skipped of listed.skipped)
      warn({ warning: 'outbox_skipped', ...skipped });
    const pending = listed.operations;
    if (pending.length)
      warn({
        pendingOperations: pending.map(
          (operation) => operation.envelope.operationId,
        ),
        next: 'taskindex operation get <id> или operation resume <id>',
      });

    if (group === 'operation' && action === 'list') {
      const corrupt = [
        ...listed.skipped.map((skipped) => ({
          ...skipped,
          file: skipped.renamedTo ?? skipped.file,
        })),
        ...(await outbox.corrupt())
          .filter(
            (file) =>
              !listed.skipped.some((skipped) => skipped.renamedTo === file),
          )
          .map((file) => ({
            file,
            reason: 'corrupt' as const,
            message: 'отложен предыдущим запуском',
          })),
      ];
      emit({
        ok: true,
        actorId,
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

    if (group === 'operation' && action === 'resume') {
      const operations = id
        ? [pending.find((operation) => operation.envelope.operationId === id)]
        : pending;
      if (operations.some((operation) => !operation))
        throw new ArgumentError('Сохранённый конверт не найден');
      let code = 0;
      for (const operation of operations) {
        const reply = await client.resume(outbox, operation!);
        emit(reply.body);
        code = Math.max(code, exitCode(reply));
      }
      if (!operations.length) emit({ ok: true, resumed: 0 });
      return code;
    }

    const encodedId = () => encodeURIComponent(required(id, 'id'));
    let path: string | undefined;
    switch (group) {
      case 'context':
        path = '/api/context';
        break;
      case 'snapshot':
        path = '/api/snapshot';
        break;
      case 'tasks':
        path = query('/api/tasks', args.flags, [
          'q',
          'area',
          'project',
          'status',
          'archived',
          'focus',
          'limit',
          'cursor',
          'generation',
        ]);
        break;
      case 'activity':
        path = query('/api/operations', args.flags, [
          'actor',
          'since',
          'until',
          'limit',
          'cursor',
          'generation',
        ]);
        break;
      case 'digest':
        path = query('/api/digest', args.flags, ['since', 'generation']);
        break;
      case 'focus':
        path = query('/api/focus', args.flags, [
          'group',
          'limit',
          'cursor',
          'generation',
        ]);
        break;
      case 'export':
        path = '/api/export';
        break;
      case 'task':
        if (action === 'get') path = `/api/tasks/${encodedId()}`;
        if (action === 'history')
          path = query(`/api/tasks/${encodedId()}/history`, args.flags, [
            'limit',
            'cursor',
            'generation',
          ]);
        if (action === 'find-origin')
          path = query('/api/tasks/by-origin', args.flags, ['system', 'ref']);
        break;
      case 'project':
        if (action === 'list') path = '/api/projects';
        break;
      case 'comment':
        if (action === 'list')
          path = query(`/api/tasks/${encodedId()}/comments`, args.flags, [
            'limit',
            'cursor',
            'generation',
          ]);
        break;
      case 'operation':
        if (action === 'get') path = `/api/operations/${encodedId()}`;
        break;
      case 'events': {
        const { interval: _interval, ...rest } = args.flags;
        path = query('/api/events', rest, ['since', 'generation', 'limit']);
        break;
      }
    }

    if (path) {
      const intervalFlag = flagString(args.flags, 'interval');
      if (intervalFlag !== undefined && !/^\d+$/.test(intervalFlag))
        throw new ArgumentError('--interval: ожидается число миллисекунд');
      const interval = Math.max(250, Number(intervalFlag ?? 1000));
      if (group === 'events' && !args.flags.generation) {
        const context = await client.request('/api/context');
        if (exitCode(context)) {
          emit(context.body);
          return exitCode(context);
        }
        path += `${path.includes('?') ? '&' : '?'}generation=${encodeURIComponent(String(context.body.generation))}`;
      }
      let result: ApiReply;
      const seen = new Set<string>();
      do {
        if (seen.has(path) && !args.flags.follow)
          throw new Error('API повторил курсор страницы');
        seen.add(path);
        try {
          result = await client.request(path);
        } catch (error) {
          if (group !== 'operation' || action !== 'get' || !id) throw error;
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
        if (group === 'operation' && action === 'get' && id) {
          // The same rule as send/resume decides whether the held envelope is settled.
          const held = pending.find(
            (operation) => operation.envelope.operationId === id,
          );
          const settled =
            held && acknowledgeStored(result, held.envelope).acknowledgement;
          if (settled?.kind === 'confirmed' || settled?.kind === 'rejected')
            await outbox.remove(id);
        }
        if (group === 'export' && args.flags.out && exitCode(result) === 0) {
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
          group === 'events' &&
          args.flags.follow &&
          exitCode(result) === 0 &&
          Array.isArray(result.body.events) &&
          !result.body.events.length
        ) {
          // Polling: an empty page is noise for an agent; only pages with
          // events (and every error) are printed.
        } else emit(result.body);
        if (exitCode(result)) return exitCode(result);
        if (group === 'events' && (args.flags.follow || args.flags.all)) {
          const events = result.body.events as { seq: number }[] | undefined;
          const cursor = events?.at(-1)?.seq;
          if (cursor !== undefined) {
            const next: URL = new URL(path, client.baseUrl);
            next.searchParams.set('since', String(cursor));
            path = `${next.pathname}${next.search}`;
          }
          if (result.body.more === true) continue;
          if (!args.flags.follow || options.signal?.aborted) break;
          await (
            options.sleep ??
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
          )(interval);
          if (options.signal?.aborted) break;
          continue;
        }
        if (!args.flags.all || result.body.more !== true) break;
        if (typeof result.body.nextCursor !== 'string')
          throw new Error('API сообщил more без nextCursor');
        const next: URL = new URL(path, client.baseUrl);
        next.searchParams.set('cursor', result.body.nextCursor);
        if (typeof result.body.generation === 'string')
          next.searchParams.set('generation', result.body.generation);
        path = `${next.pathname}${next.search}`;
      } while (!options.signal?.aborted);
      return 0;
    }

    const operationId = flagString(args.flags, 'operation-id') ?? randomUUID();
    outbox.path(operationId);
    let endpoint: SavedOperation['endpoint'] = '/api/commands';
    let command: string | undefined;
    let payload: Record<string, unknown> | undefined;
    let commands: unknown[] | undefined;
    if (group === 'batch') {
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
      payload = await payloadFromFlags(args, input);
      if (group === 'undo') {
        command = 'undo';
        const operation = flagString(args.flags, 'operation');
        if (operation) payload.operationId = operation;
        else if (action !== undefined) payload.seq = Number(action);
      } else {
        command = `${group}.${action}`;
        if (group === 'task' && action === 'focus') {
          command = 'task.update';
          payload.focus ??= true;
        }
        if (group === 'task' || group === 'project')
          setPositional(payload, 'id', id);
        if (group === 'checklist') {
          setPositional(payload, 'taskId', id);
          setPositional(payload, 'itemId', itemId);
        }
        if (group === 'comment')
          setPositional(
            payload,
            action === 'remove' ? 'commentId' : 'taskId',
            id,
          );
      }
      if (!Object.hasOwn(commandPayloadSchemas, command))
        throw new ArgumentError(`Неизвестная команда: ${command}`);
      const validation =
        commandPayloadSchemas[command as CommandName].safeParse(payload);
      if (!validation.success) {
        emit({
          ok: false,
          code: 'invalid_arguments',
          issues: validation.error.issues,
        });
        return 2;
      }
      payload = validation.data as Record<string, unknown>;
    }
    const saved = await outbox.get(operationId);
    let generation =
      flagString(args.flags, 'generation') ?? saved?.envelope.generation;
    if (!generation) {
      const context = await client.request('/api/context');
      if (exitCode(context)) {
        emit(context.body);
        return exitCode(context);
      }
      generation = required(
        typeof context.body.generation === 'string'
          ? context.body.generation
          : undefined,
        'generation в ответе context',
      );
    }
    const envelope = {
      operationId,
      generation,
      ...(flagBoolean(args.flags, 'dry-run') !== undefined
        ? { dryRun: flagBoolean(args.flags, 'dry-run') }
        : {}),
      ...(commands ? { commands } : { command, payload }),
    };
    const parsedEnvelope = (
      commands ? batchEnvelopeSchema : commandEnvelopeSchema
    ).safeParse(envelope);
    if (!parsedEnvelope.success) {
      emit({
        ok: false,
        code: 'invalid_arguments',
        issues: parsedEnvelope.error.issues,
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
    emit(reply.body);
    return exitCode(reply);
  } catch (error) {
    emit({
      ok: false,
      code:
        error instanceof ArgumentError ? 'invalid_arguments' : 'client_error',
      message: error instanceof Error ? error.message : 'Ошибка CLI',
      ...(error instanceof ArgumentError && error.hint
        ? { hint: error.hint }
        : {}),
      ...(error instanceof CorruptEnvelopeError ? error.skipped : {}),
    });
    return error instanceof ArgumentError ? 2 : 1;
  }
}
