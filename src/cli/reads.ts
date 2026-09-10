import { writeFile } from 'node:fs/promises';
import { acknowledgeStored } from './acknowledge.js';
import {
  ArgumentError,
  flagString,
  required,
  type Arguments,
} from './arguments.js';
import { exitCode, type ApiReply } from './client.js';
import { withHints } from './errors.js';
import { readFlags } from './help.js';
import { currentGeneration, type Session } from './session.js';
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

// The position of the read in the operation log: `/api/digest` reports it as
// `operationSeq`, a page of `/api/operations` carries it on every item, and
// the walk ends on the largest one it saw. Without it the cursor keeps the
// operation position it already had (TI-008).
export function operationSeqOf(
  body: Record<string, unknown>,
): number | undefined {
  if (typeof body.operationSeq === 'number') return body.operationSeq;
  if (!Array.isArray(body.items)) return undefined;
  let largest: number | undefined;
  for (const item of body.items) {
    const value = (item as { operationSeq?: unknown }).operationSeq;
    if (typeof value === 'number' && (largest === undefined || value > largest))
      largest = value;
  }
  return largest;
}

// `--commit`: the cursor moves only when the read was complete — every page
// walked (`more: false`) — to the position the server reported for it.
async function commitRead(
  session: Session,
  spec: ReadSpec,
  body: Record<string, unknown>,
  operationSeq = operationSeqOf(body),
): Promise<void> {
  const { state, identity, warn } = session;
  const part = (name: string) =>
    (body[name] as { more?: unknown } | undefined)?.more === true;
  const incomplete =
    spec.group === 'digest'
      ? part('operations')
      : spec.group === 'inbox'
        ? part('comments')
        : body.more === true;
  if (incomplete) {
    warn({
      warning: 'cursor_not_committed',
      reason: 'more',
      message: 'Прочитаны не все страницы; курсор не сдвинут',
      next:
        spec.group === 'digest'
          ? 'taskindex activity --since last --all --commit'
          : spec.group === 'inbox'
            ? 'taskindex inbox --since <seq последнего показанного комментария>'
            : `taskindex ${spec.group} --since last --all --commit`,
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
    ...(operationSeq !== undefined ? { operationSeq } : {}),
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
    if (args.flags.commit && last)
      await commitRead(
        session,
        spec,
        last,
        pages.reduce<number | undefined>((largest, body) => {
          const value = operationSeqOf(body);
          return value !== undefined &&
            (largest === undefined || value > largest)
            ? value
            : largest;
        }, undefined),
      );
    return 0;
  }
}

// `--since last` resolves the committed cursor; without one the read starts
// at 0 under the server's current generation, which loses nothing. Events
// always carry a generation, fetched when not given.
async function resolveSince(
  session: Session,
  spec: ReadSpec,
): Promise<Arguments['flags']> {
  const flags = { ...session.args.flags };
  if (flags.since === 'last') {
    const cursor = await session.state.readCursor(session.identity);
    if (spec.group === 'activity') {
      // The operation log has its own position: `after` shows rejections and
      // operations without events, which the event window `since` never does.
      delete flags.since;
      flags.after ??= String(cursor?.operationSeq ?? 0);
    } else flags.since = String(cursor?.seq ?? 0);
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
  if (
    (spec.group === 'events' || session.args.flags.since === 'last') &&
    !flags.generation
  )
    flags.generation = await currentGeneration(session);
  return flags;
}

function intervalOf(args: Arguments): number {
  const value = flagString(args.flags, 'interval');
  if (value !== undefined && !/^\d+$/.test(value))
    throw new ArgumentError('--interval: ожидается число миллисекунд');
  return Math.max(250, Number(value ?? 1000));
}

// `inbox`: the agent reads /api/digest but is shown only what is addressed to
// it — the owner's comments with their text, task and `seq` — plus the two
// positions of the read, so the next `--since` is in the same line of output.
export function inboxOf(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const comments = body.comments as
    | { items?: unknown; more?: unknown; href?: unknown }
    | undefined;
  return {
    generation: body.generation,
    seq: body.seq,
    ...(typeof body.operationSeq === 'number'
      ? { operationSeq: body.operationSeq }
      : {}),
    comments: Array.isArray(comments?.items) ? comments.items : [],
    more: comments?.more === true,
    ...(typeof comments?.href === 'string' ? { href: comments.href } : {}),
  };
}

// One read: a single page, `export --out`, `operation get` (which settles the
// held envelope by the same rule as send/resume), or `events` walked by
// `since` with `--all` / polled with `--follow`.
export async function runRead(
  session: Session,
  spec: ReadSpec,
  rest: string[],
): Promise<number> {
  const { args, client, options, emit, outbox, pending } = session;
  let path = readPath(spec, rest, await resolveSince(session, spec));
  if (args.flags.all && spec.pageable) return walkPages(session, spec, path);
  const interval = intervalOf(args);
  const isEvents = spec.group === 'events';
  const streaming = isEvents && (args.flags.follow || args.flags.all);
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
    } else if (spec.group === 'inbox' && exitCode(result) === 0)
      emit(inboxOf(result.body));
    else emit(exitCode(result) ? withHints(result.body) : result.body);
    if (exitCode(result)) return exitCode(result);
    if (!streaming) break;
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
  } while (!options.signal?.aborted);
  if (args.flags.commit && !streaming)
    await commitRead(session, spec, result.body);
  return 0;
}
