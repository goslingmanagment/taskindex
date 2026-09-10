import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  generation,
  readState,
  withRead,
  withWrite,
} from '../../src/server/db.js';
import { executeOperation } from '../../src/server/operations.js';
import { owner } from './helpers.js';
it('keeps acknowledged operations across a file-backed reopen and applies FULL on every connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-sqlite-test-'));
  const path = join(dir, 'db.sqlite');
  let db = openDatabase(path);
  try {
    migrate(db);
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.sqlite.pragma('synchronous', { simple: true })).toBe(2);
    const gen = generation(db);
    const envelope = {
      command: 'task.create' as const,
      payload: { id: 't', area: 'agency' as const, title: 'Durable' },
      generation: gen,
      operationId: 'durable',
    };
    const first = executeOperation(db, envelope, owner);
    expect(first.status).toBe(200);
    db.close();
    db = openDatabase(path);
    expect(generation(db)).toBe(gen);
    expect(db.sqlite.pragma('synchronous', { simple: true })).toBe(2);
    expect(readState(db).tasks[0]!.title).toBe('Durable');
    expect(executeOperation(db, envelope, owner).body).toEqual(first.body);
    expect(readState(db).tasks).toHaveLength(1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Plan 06, step 6: the two transaction shapes. A write rolls back whole, and a
// read is deferred, so it never waits on an open writer for its own snapshot.
it('rolls a failed withWrite back whole and never blocks withRead on the writer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskindex-tx-test-'));
  const path = join(dir, 'db.sqlite');
  const writer = openDatabase(path);
  const reader = openDatabase(path);
  try {
    migrate(writer);
    const before = readState(writer);
    expect(() =>
      withWrite(writer, () => {
        writer.sqlite
          .prepare(
            "INSERT INTO projects(id, area, name, name_key, description, color, revision, created_at, updated_at) VALUES ('p','agency','Имя','имя','', '#112233', 1, '', '')",
          )
          .run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(readState(writer)).toEqual(before);
    // The writer holds the write lock; a deferred read must answer at once
    // instead of waiting out busy_timeout (5000 ms).
    let elapsed = 0;
    withWrite(writer, () => {
      const started = Date.now();
      expect(withRead(reader, () => readState(reader).tasks)).toEqual([]);
      elapsed = Date.now() - started;
    });
    expect(elapsed).toBeLessThan(100);
  } finally {
    writer.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
