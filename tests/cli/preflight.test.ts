import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkNode, readPins } from '../../scripts/preflight.mjs';

const run = promisify(execFile);
const script = resolve('scripts/preflight.mjs');

// Другой мажорный Node, если он есть на этой машине: проверка настоящего
// отказа preflight; на машинах без него сценарий пропускается.
async function foreignNode(): Promise<string | undefined> {
  for (const candidate of [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    join(homedir(), '.local', 'bin', 'node'),
  ]) {
    try {
      const { stdout } = await run(candidate, ['--version']);
      if (!stdout.startsWith('v24.')) return candidate;
    } catch {
      // not installed here
    }
  }
  return undefined;
}

describe('scripts/preflight.mjs', () => {
  it('accepts only the supported major and explains the fix in Russian', () => {
    const engines = readPins().engines;
    expect(engines).toBe('>=24.11.0 <25');
    expect(checkNode('24.20.0', engines)).toEqual({ ok: true });
    expect(checkNode('24.11.0', engines)).toEqual({ ok: true });
    for (const version of ['26.7.0', '24.10.9', '25.0.0', '22.12.0']) {
      const result = checkNode(version, engines);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(`запущен v${version}`);
        expect(result.message).toContain('better-sqlite3');
        expect(result.message).toContain('.node-version');
        expect(result.message).not.toContain('/private/tmp');
      }
    }
    expect(readPins().pinned).toBe('24.20.0');
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
    expect(failure.stderr).toContain('TaskIndex требует Node >=24.11.0 <25');
    expect(failure.stderr).not.toContain('at ');
  });
});
