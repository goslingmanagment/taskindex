import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { ArgumentError } from './arguments.js';

export interface Envelope {
  operationId: string;
  generation: string;
  dryRun?: boolean;
  command?: string;
  payload?: Record<string, unknown>;
  commands?: unknown[];
}

export interface SavedOperation {
  formatVersion: 1;
  baseUrl: string;
  endpoint: '/api/commands' | '/api/commands/batch';
  envelope: Envelope;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameOperation(
  left: SavedOperation,
  right: SavedOperation,
): boolean {
  return canonical(left) === canonical(right);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class Outbox {
  readonly directory: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.directory = join(
      env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
      'taskindex',
      'ops',
    );
  }

  path(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
      throw new ArgumentError('operationId: недопустимый идентификатор');
    return join(this.directory, `${id}.json`);
  }

  async get(id: string): Promise<SavedOperation | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path(id), 'utf8'),
      ) as SavedOperation;
      if (
        parsed.formatVersion !== 1 ||
        parsed.envelope?.operationId !== id ||
        !parsed.baseUrl ||
        !['/api/commands', '/api/commands/batch'].includes(parsed.endpoint)
      ) {
        throw new ArgumentError(
          `Повреждён конверт ${id}; сохранённый файл оставлен для проверки`,
        );
      }
      return parsed;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async list(baseUrl: string): Promise<SavedOperation[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const operations: SavedOperation[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const operation = await this.get(file.slice(0, -5));
      if (operation?.baseUrl === baseUrl) operations.push(operation);
    }
    return operations;
  }

  async put(operation: SavedOperation): Promise<void> {
    const destination = this.path(operation.envelope.operationId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(operation)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // link() is an atomic, no-overwrite publication: concurrent invocations
      // cannot replace another request that has the same operationId.
      await link(temporary, destination);
      const directory = await open(dirname(destination), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await this.get(operation.envelope.operationId);
      if (!previous || !sameOperation(previous, operation)) {
        throw new ArgumentError(
          'operationId уже принадлежит другому сохранённому запросу; конверт не заменён',
        );
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.path(id));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

// A nonsecret server identifier is useful in diagnostics without writing tokens.
export function serverId(baseUrl: string): string {
  return createHash('sha256').update(baseUrl).digest('hex').slice(0, 12);
}
