import { readInput } from './input.js';
import { required, type Arguments } from './arguments.js';
import { ApiClient, exitCode, type ApiReply } from './client.js';
import type { Outbox, SavedOperation, SkippedFile } from './outbox.js';
import { CliState, type Identity } from './state.js';

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

// Everything a command needs once the key is identified: the client, the
// state directory of this server and agent, its pending envelopes and the
// two output channels (stdout for results, stderr for diagnostics).
export interface Session {
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

// A server reply that ends the command before its own request was made
// (for example an error while asking for the generation): `runCli` prints it
// and exits with its code.
export class ReplyExit extends Error {
  constructor(readonly reply: ApiReply) {
    super('server reply ends the command');
    this.name = 'ReplyExit';
  }
}

export async function openSession(
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

// The current generation of the server: `/api/me` is the light request; a
// server whose `me` has no generation yet answers through `/api/context`.
export async function currentGeneration(session: Session): Promise<string> {
  const me = await session.client.request('/api/me');
  const reply =
    exitCode(me) || typeof me.body.generation === 'string'
      ? me
      : await session.client.request('/api/context');
  if (exitCode(reply)) throw new ReplyExit(reply);
  return required(
    typeof reply.body.generation === 'string'
      ? reply.body.generation
      : undefined,
    'generation в ответе сервера',
  );
}
