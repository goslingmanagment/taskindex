import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { ArgumentError } from './arguments.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { operationEnvelopeSchema, z } from '../shared/schemas.js';

export const OUTBOX_FORMAT_VERSION = 2;
// A published link is made durable by syncing its directory. Windows has no
// directory fsync (the handle answers EPERM) and NTFS journals the link
// itself, so only there the error is not a failure.
/** @internal for tests */
export function directorySyncUnsupported(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'win32' &&
    (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  );
}

// The persisted intent of one CLI write: enough to resend exactly the same
// envelope to the same server and to prove which actor saved it.
const savedOperationSchema = z
  .object({
    formatVersion: z.literal(OUTBOX_FORMAT_VERSION),
    baseUrl: z.string().min(1),
    endpoint: z.enum(['/api/commands', '/api/commands/batch']),
    actorId: z.string().min(1),
    savedAt: z.iso.datetime({ offset: true }).optional(),
    envelope: operationEnvelopeSchema,
  })
  .strict();
export type SavedOperation = z.infer<typeof savedOperationSchema>;

export interface SkippedFile {
  file: string;
  reason: 'name' | 'json' | 'schema' | 'read' | 'actor';
  message: string;
  renamedTo?: string;
}

export class CorruptEnvelopeError extends Error {
  constructor(readonly skipped: SkippedFile) {
    super(
      skipped.renamedTo
        ? `Повреждён конверт ${skipped.file}; файл переименован в ${skipped.renamedTo}`
        : `Повреждён конверт ${skipped.file}: ${skipped.message}`,
    );
    this.name = 'CorruptEnvelopeError';
  }
}

const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

// The one canonical form of the product (`canonicalJson`): the same bytes the
// server hashes into `commandHash`, so a resaved envelope and the stored
// operation stay the same intent. A second local implementation could sort
// keys differently and silently split one operation in two (TI-061).
/** @internal for tests */
export function sameOperation(
  left: SavedOperation,
  right: SavedOperation,
): boolean {
  const strip = ({ savedAt: _savedAt, ...rest }: SavedOperation) => rest;
  return canonicalJson(strip(left)) === canonicalJson(strip(right));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class Outbox {
  constructor(readonly directory: string) {}

  path(id: string): string {
    if (!idPattern.test(id))
      throw new ArgumentError('operationId: недопустимый идентификатор');
    return join(this.directory, `${id}.json`);
  }

  // Reads one envelope. A file that cannot be executed is renamed to
  // `<name>.corrupt` (bytes preserved) and reported, never silently deleted.
  async get(id: string): Promise<SavedOperation | undefined> {
    const file = this.path(id);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new CorruptEnvelopeError({
        file,
        reason: 'read',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw await this.quarantine(file, 'json', error);
    }
    const parsed = savedOperationSchema.safeParse(raw);
    if (!parsed.success)
      throw await this.quarantine(
        file,
        'schema',
        `формат конверта не распознан (${parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join('.') || 'корень')
          .join(', ')})`,
      );
    if (parsed.data.envelope.operationId !== id)
      throw await this.quarantine(
        file,
        'schema',
        'operationId внутри файла не совпадает с именем файла',
      );
    return parsed.data;
  }

  private async quarantine(
    file: string,
    reason: SkippedFile['reason'],
    cause: unknown,
  ): Promise<CorruptEnvelopeError> {
    const message = cause instanceof Error ? cause.message : String(cause);
    const renamedTo = `${file}.corrupt`;
    try {
      await rename(file, renamedTo);
      return new CorruptEnvelopeError({ file, reason, message, renamedTo });
    } catch {
      return new CorruptEnvelopeError({ file, reason, message });
    }
  }

  // Lists the executable envelopes; each broken file is isolated separately so
  // one bad file never hides the others or blocks an unrelated command.
  async list(): Promise<{
    operations: SavedOperation[];
    skipped: SkippedFile[];
  }> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return { operations: [], skipped: [] };
      throw error;
    }
    const operations: SavedOperation[] = [];
    const skipped: SkippedFile[] = [];
    for (const file of files.sort()) {
      if (file.startsWith('.pending-')) {
        await this.expirePending(join(this.directory, file));
        continue;
      }
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!idPattern.test(id)) {
        skipped.push({
          file: join(this.directory, file),
          reason: 'name',
          message: 'имя файла не является operationId',
        });
        continue;
      }
      try {
        const operation = await this.get(id);
        if (operation) operations.push(operation);
      } catch (error) {
        if (!(error instanceof CorruptEnvelopeError)) throw error;
        skipped.push(error.skipped);
      }
    }
    return { operations, skipped };
  }

  // Files already set aside by earlier runs, kept for manual inspection.
  async corrupt(): Promise<string[]> {
    try {
      return (await readdir(this.directory))
        .filter((file) => file.endsWith('.corrupt'))
        .sort()
        .map((file) => join(this.directory, file));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async expirePending(file: string): Promise<void> {
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > PENDING_MAX_AGE_MS) await unlink(file);
    } catch {
      // A concurrent writer may have finished with it; nothing to clean.
    }
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
      await this.publish(temporary, destination, operation);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async publish(
    temporary: string,
    destination: string,
    operation: SavedOperation,
    retried = false,
  ): Promise<void> {
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: SavedOperation | undefined;
      try {
        previous = await this.get(operation.envelope.operationId);
      } catch (corrupt) {
        if (!(corrupt instanceof CorruptEnvelopeError) || retried)
          throw corrupt;
        // The occupant was unreadable and has been set aside; publish again.
        return this.publish(temporary, destination, operation, true);
      }
      if (!previous || !sameOperation(previous, operation)) {
        throw new ArgumentError(
          'operationId уже принадлежит другому сохранённому запросу; конверт не заменён',
        );
      }
      return;
    }
    const directory = await open(dirname(destination), 'r');
    try {
      await directory.sync();
    } catch (error) {
      if (!directorySyncUnsupported(error)) throw error;
    } finally {
      await directory.close();
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
