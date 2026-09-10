import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { actorSchema } from '../shared/domain-schemas.js';
import { z } from '../shared/schemas.js';
import type { ApiReply } from './client.js';
import { Outbox, type SavedOperation, type SkippedFile } from './outbox.js';

// A nonsecret server identifier: keeps envelopes of different servers apart
// without writing the URL into a directory name.
export function serverId(baseUrl: string): string {
  return createHash('sha256')
    .update(baseUrl.replace(/\/$/, ''))
    .digest('hex')
    .slice(0, 12);
}

// The token itself is never stored; its hash only names the identity cache.
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export const identitySchema = z
  .object({
    formatVersion: z.literal(1),
    actorId: z.string().min(1),
    agentId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    label: z.string(),
    kind: z.enum(['owner', 'agent']),
    scope: z.enum(['read', 'tasks', 'write']),
    fetchedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type Identity = z.infer<typeof identitySchema>;

// The last position an agent has fully processed: events by `seq`, and, once
// the server numbers operations, the operation feed by `operationSeq`. Written
// only by an explicit commit, never by a read on its own.
export const cursorSchema = z
  .object({
    formatVersion: z.literal(1),
    generation: z.string().min(1),
    seq: z.number().int().nonnegative(),
    operationSeq: z.number().int().nonnegative().optional(),
    committedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type Cursor = z.infer<typeof cursorSchema>;

export interface StatePaths {
  root: string;
  server: string;
  identities: string;
  agents: string;
  legacyOps: string;
  ops: (agentKey: string) => string;
  cursor: (agentKey: string) => string;
}

// $XDG_STATE_HOME/taskindex/
//   servers/<serverId>/identities/<tokenHash>.json   cached GET /api/me
//   servers/<serverId>/agents/<agentId>/ops/          envelopes of this agent
//   servers/<serverId>/agents/<agentId>/cursor.json   committed read position
//   ops/                                              layout of formatVersion 1
export function statePaths(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
): StatePaths {
  const root = join(
    env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'taskindex',
  );
  const server = join(root, 'servers', serverId(baseUrl));
  const agents = join(server, 'agents');
  return {
    root,
    server,
    identities: join(server, 'identities'),
    agents,
    legacyOps: join(root, 'ops'),
    ops: (agentKey) => join(agents, agentKey, 'ops'),
    cursor: (agentKey) => join(agents, agentKey, 'cursor.json'),
  };
}

export interface IdentityResolution {
  identity?: Identity;
  warning?: Record<string, unknown>;
}

function directoryKey(actor: { id: string; agentId?: string }): string {
  return actor.agentId ?? actor.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

export class CliState {
  readonly paths: StatePaths;
  readonly tokenHash: string;
  constructor(
    env: NodeJS.ProcessEnv,
    readonly baseUrl: string,
    token: string,
  ) {
    this.paths = statePaths(env, baseUrl);
    this.tokenHash = tokenHash(token);
  }

  // Without a known identity the envelopes are kept under the key hash; they
  // are adopted by the agent directory as soon as GET /api/me succeeds.
  get fallbackKey(): string {
    return `key-${this.tokenHash}`;
  }

  private get cacheFile(): string {
    return join(this.paths.identities, `${this.tokenHash}.json`);
  }

  async cachedIdentity(): Promise<Identity | undefined> {
    let text: string;
    try {
      text = await readFile(this.cacheFile, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = identitySchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async identify(
    fetchMe: () => Promise<ApiReply>,
  ): Promise<IdentityResolution> {
    const cached = await this.cachedIdentity();
    if (cached) return { identity: cached };
    let reply: ApiReply;
    try {
      reply = await fetchMe();
    } catch (error) {
      return {
        warning: {
          warning: 'identity_unknown',
          reason: 'network',
          message: `Не удалось запросить /api/me (${error instanceof Error ? error.message : String(error)}); конверты сохраняются под хешем ключа до первого успешного запроса`,
        },
      };
    }
    const actor =
      reply.status >= 200 && reply.status < 300
        ? actorSchema.safeParse(reply.body)
        : undefined;
    if (!actor?.success)
      return {
        warning: {
          warning: 'identity_unknown',
          reason: 'response',
          status: reply.status,
          ...(typeof reply.body.code === 'string'
            ? { code: reply.body.code }
            : {}),
          message:
            'Ответ /api/me не описывает актора; конверты сохраняются под хешем ключа',
        },
      };
    const identity: Identity = {
      formatVersion: 1,
      actorId: actor.data.id,
      agentId: directoryKey(actor.data),
      label: actor.data.label,
      kind: actor.data.kind,
      scope: actor.data.scope,
      fetchedAt: new Date().toISOString(),
    };
    await mkdir(this.paths.identities, { recursive: true, mode: 0o700 });
    await writeFile(this.cacheFile, `${JSON.stringify(identity)}\n`, {
      mode: 0o600,
    });
    await this.adopt(identity);
    return { identity };
  }

  actorId(identity?: Identity): string {
    return identity?.actorId ?? `key:${this.tokenHash}`;
  }

  agentKey(identity?: Identity): string {
    return identity?.agentId ?? this.fallbackKey;
  }

  outbox(identity?: Identity): Outbox {
    return new Outbox(this.paths.ops(this.agentKey(identity)));
  }

  cursorFile(identity?: Identity): string {
    return this.paths.cursor(this.agentKey(identity));
  }

  // A cursor that cannot be read is treated as absent: the next `--since last`
  // starts from 0, which loses nothing.
  async readCursor(identity?: Identity): Promise<Cursor | undefined> {
    let text: string;
    try {
      text = await readFile(this.cursorFile(identity), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = cursorSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  // The file holds two independent positions of the same generation: the event
  // feed (`seq`) and the operation log (`operationSeq`). A commit that knows
  // only one of them keeps the other, so reading events never loses the place
  // in the operation log and back (TI-008). A new generation drops both.
  async commitCursor(
    identity: Identity | undefined,
    position: { generation: string; seq: number; operationSeq?: number },
  ): Promise<Cursor> {
    const previous = await this.readCursor(identity);
    const operationSeq =
      position.operationSeq ??
      (previous?.generation === position.generation
        ? previous.operationSeq
        : undefined);
    const cursor: Cursor = {
      formatVersion: 1,
      generation: position.generation,
      seq: position.seq,
      ...(operationSeq !== undefined ? { operationSeq } : {}),
      committedAt: new Date().toISOString(),
    };
    const file = this.cursorFile(identity);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
    return cursor;
  }

  async resetCursor(identity?: Identity): Promise<void> {
    try {
      await unlink(this.cursorFile(identity));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  // Own pending envelopes. A file whose actor does not match the current one
  // is not executable here and is reported like any other unusable file.
  async pending(identity?: Identity): Promise<{
    operations: SavedOperation[];
    skipped: SkippedFile[];
  }> {
    const outbox = this.outbox(identity);
    const listed = await outbox.list();
    const actorId = this.actorId(identity);
    const operations: SavedOperation[] = [];
    for (const operation of listed.operations) {
      if (operation.actorId === actorId) operations.push(operation);
      else
        listed.skipped.push({
          file: outbox.path(operation.envelope.operationId),
          reason: 'actor',
          message: `конверт сохранён другим актором (${operation.actorId})`,
        });
    }
    return { operations, skipped: listed.skipped };
  }

  private async adopt(identity: Identity): Promise<void> {
    const fallback = new Outbox(this.paths.ops(this.fallbackKey));
    const { operations } = await fallback.list();
    if (!operations.length) return;
    const target = this.outbox(identity);
    for (const operation of operations) {
      try {
        await target.put({ ...operation, actorId: identity.actorId });
        await fallback.remove(operation.envelope.operationId);
      } catch {
        // Left in place: a different envelope already owns this operationId.
      }
    }
  }

  // Envelopes of the previous layout cannot be attributed to an agent, so they
  // are only reported; the owner resolves them with `operation get`.
  async legacyPending(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.paths.legacyOps);
    } catch {
      return [];
    }
    const own: string[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(
          await readFile(join(this.paths.legacyOps, file), 'utf8'),
        ) as { baseUrl?: unknown };
        if (parsed.baseUrl === this.baseUrl) own.push(file);
      } catch {
        own.push(file);
      }
    }
    return own;
  }
}
