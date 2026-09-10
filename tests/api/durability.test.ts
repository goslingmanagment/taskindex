import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import {
  openDatabase,
  migrate,
  generation,
  readState,
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
