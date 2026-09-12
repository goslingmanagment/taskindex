import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkNode, readPins } from '../../scripts/preflight.mjs';

const run = promisify(execFile);
const script = resolve('scripts/preflight.mjs');

// Другой мажорный Node, если он есть на этой машине: проверка настоящего
// отказа preflight; на машинах без него сценарий пропускается. Кроме
// системных путей смотрим каталоги fnm и nvm, где лежат прежние мажоры.
async function candidates(): Promise<string[]> {
  const found = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    join(homedir(), '.local', 'bin', 'node'),
  ];
  const managers = [
    {
      dir: join(homedir(), '.local', 'share', 'fnm', 'node-versions'),
      tail: ['installation', 'bin', 'node'],
    },
    {
      dir: join(
        homedir(),
        'Library',
        'Application Support',
        'fnm',
        'node-versions',
      ),
      tail: ['installation', 'bin', 'node'],
    },
    { dir: join(homedir(), '.nvm', 'versions', 'node'), tail: ['bin', 'node'] },
  ];
  for (const { dir, tail } of managers) {
    try {
      for (const entry of await readdir(dir))
        found.push(join(dir, entry, ...tail));
    } catch {
      // manager not installed here
    }
  }
  return found;
}

async function foreignNode(): Promise<string | undefined> {
  const pinnedMajor = `v${readPins().pinned.split('.')[0]}.`;
  for (const candidate of await candidates()) {
    try {
      const { stdout } = await run(candidate, ['--version']);
      if (!stdout.startsWith(pinnedMajor)) return candidate;
    } catch {
      // not installed here
    }
  }
  return undefined;
}

describe('scripts/preflight.mjs', () => {
  it('accepts only the supported major and explains the fix in Russian', () => {
    const engines = readPins().engines;
    expect(engines).toBe('>=26.0.0 <27');
    expect(checkNode('26.7.0', engines)).toEqual({ ok: true });
    expect(checkNode('26.0.0', engines)).toEqual({ ok: true });
    for (const version of ['24.20.0', '25.9.0', '27.0.0', '22.12.0']) {
      const result = checkNode(version, engines);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(`запущен v${version}`);
        expect(result.message).toContain('better-sqlite3');
        expect(result.message).toContain('.node-version');
        expect(result.message).not.toContain('/private/tmp');
      }
    }
    expect(readPins().pinned).toBe('26.7.0');
  });

  it('is silent with exit 0 under the pinned Node', async () => {
    const { stdout, stderr } = await run(process.execPath, [script]);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('fails fast with exit 1 and no native-module trace under another major', async () => {
    const node = await foreignNode();
    if (!node) return;
    const failure = await run(node, [script]).catch(
      (error: { code: number; stderr: string; stdout: string }) => error,
    );
    expect(failure).toMatchObject({ code: 1, stdout: '' });
    expect(failure.stderr).toContain('TaskIndex требует Node >=26.0.0 <27');
    expect(failure.stderr).not.toContain('at ');
  });
});
