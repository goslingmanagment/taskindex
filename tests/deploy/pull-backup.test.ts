import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const run = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0))
    await rm(dir, { recursive: true, force: true });
});
// pull-backup.sh on the owner's Mac: the server is reached through `ssh`, which
// a stand-in on PATH answers with a database-sized blob and an export.
async function stubSsh() {
  const bin = await mkdtemp(join(tmpdir(), 'taskindex-ssh-'));
  cleanup.push(bin);
  await writeFile(
    join(bin, 'ssh'),
    [
      '#!/usr/bin/env bash',
      'case "$2" in',
      "  *'taskindex-admin export'*) printf '{}\\n' ;;",
      '  *) head -c 8192 /dev/zero ;;',
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'ssh'), 0o755);
  return bin;
}

it('rotates only the dated copies and keeps the other folders of the backup directory', async () => {
  const bin = await stubSsh();
  const backups = await mkdtemp(join(tmpdir(), 'taskindex-backups-'));
  cleanup.push(backups);
  const older = [
    '20200101T013000Z',
    '20200102T013000Z',
    '20200103T013000Z',
    '20200104T013000Z',
  ];
  const others = ['logs', 'releases', 'qa-20260912'];
  for (const name of [...older, ...others]) await mkdir(join(backups, name));
  const { stdout } = await run('bash', ['deploy/pull-backup.sh'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TASKINDEX_BACKUP_DIR: backups,
      TASKINDEX_BACKUP_KEEP: '3',
    },
  });
  const result = JSON.parse(stdout) as { ok: boolean; path: string };
  expect(result.ok).toBe(true);
  const fresh = result.path.slice(backups.length + 1);
  expect(fresh).toMatch(/^\d{8}T\d{6}Z$/);
  expect((await readdir(backups)).toSorted()).toEqual(
    [...others, '20200103T013000Z', '20200104T013000Z', fresh].toSorted(),
  );
  expect((await readdir(join(backups, fresh))).toSorted()).toEqual([
    'export.json',
    'taskindex.db',
  ]);
});
