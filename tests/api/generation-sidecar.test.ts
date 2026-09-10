// Ж13 (plan 09, step 9), stage 1: the generation of the database is mirrored
// in a file next to it, so a file swapped in without mark-restored is visible
// in the log at start-up instead of silently answering the old generation.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  generation,
  generationSidecarPath,
  checkGenerationSidecar,
} from '../../src/server/db.js';
import { markRestored } from '../../src/server/admin.js';
import type { LogFields } from '../../src/server/log.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function collector() {
  const entries: LogFields[] = [];
  return {
    entries,
    logger: { warn: (fields: LogFields) => entries.push(fields) },
  };
}

function fileDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-sidecar-'));
  const path = join(dir, 'db.sqlite');
  const db = openDatabase(path);
  cleanup.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, path };
}

describe('generation sidecar (Ж13, stage 1)', () => {
  it('writes the sidecar on migrate and on mark-restored', () => {
    const { db, path } = fileDatabase();
    migrate(db);
    const sidecar = generationSidecarPath(path);
    expect(readFileSync(sidecar, 'utf8')).toBe(generation(db));
    const restored = markRestored(db);
    expect(restored.generation).not.toBe('');
    expect(readFileSync(sidecar, 'utf8')).toBe(restored.generation);
    expect(readFileSync(sidecar, 'utf8')).toBe(generation(db));
  });

  it('warns when the file next to the database names another generation', () => {
    const { db, path } = fileDatabase();
    migrate(db);
    const quiet = collector();
    checkGenerationSidecar(db, quiet.logger);
    expect(quiet.entries).toEqual([]);
    writeFileSync(generationSidecarPath(path), 'someone-elses-generation');
    const noisy = collector();
    checkGenerationSidecar(db, noisy.logger);
    expect(noisy.entries).toHaveLength(1);
    expect(noisy.entries[0]).toMatchObject({
      event: 'generation_sidecar_mismatch',
      sidecar: 'someone-elses-generation',
      generation: generation(db),
    });
  });

  it('does nothing for an in-memory database or a missing file', () => {
    const memory = openDatabase(':memory:');
    cleanup.push(() => memory.close());
    migrate(memory);
    const quiet = collector();
    expect(() => checkGenerationSidecar(memory, quiet.logger)).not.toThrow();
    const { db, path } = fileDatabase();
    migrate(db);
    rmSync(generationSidecarPath(path));
    checkGenerationSidecar(db, quiet.logger);
    expect(quiet.entries).toEqual([]);
  });
});
