import { readFile, readlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { readFlags, renderHelp } from '../../src/cli/help.js';
import {
  GLOBAL_FLAGS,
  READS,
  SERVICE,
  WRITES,
  WRITE_FLAGS,
  commandName,
  payloadFlags,
} from '../../src/cli/spec.js';

// Every command and flag the CLI knows, from the specification only.
function knownCommands(): Set<string> {
  return new Set(
    [...READS, ...WRITES, ...SERVICE].map((spec) => commandName(spec)),
  );
}

function knownFlags(): Set<string> {
  const names = new Set<string>();
  for (const entry of [...GLOBAL_FLAGS, ...WRITE_FLAGS])
    names.add(`--${entry.name}`);
  for (const read of READS)
    for (const entry of readFlags(read)) names.add(`--${entry.name}`);
  for (const write of WRITES)
    if (write.command !== 'batch')
      for (const entry of payloadFlags(write.command))
        names.add(`--${entry.name}`);
  for (const service of SERVICE)
    for (const entry of service.flags ?? []) names.add(`--${entry.name}`);
  return names;
}

// Documentation that agents follow must not drift from the CLI and the pins.
describe('documentation against the code', () => {
  it('pins one Node version everywhere and points AGENTS.md at CLAUDE.md', async () => {
    const nodeVersion = (await readFile('.node-version', 'utf8')).trim();
    expect((await readFile('.nvmrc', 'utf8')).trim()).toBe(nodeVersion);
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe('>=26.0.0 <27');
    expect(await readFile('README.md', 'utf8')).toContain(nodeVersion);
    expect(await readlink('AGENTS.md')).toBe('CLAUDE.md');
    expect(await readFile('.npmrc', 'utf8')).toContain('engine-strict=true');
  });

  it('keeps the acceptance checklist in docs/acceptance, not in tests', async () => {
    for (const file of ['README.md', 'BACKLOG.md', 'CLAUDE.md'])
      expect(await readFile(file, 'utf8')).not.toContain(
        'tests/e2e/agent-cycle.md',
      );
    expect(await readFile('BACKLOG.md', 'utf8')).toContain(
      'docs/acceptance/agent-cycle.md',
    );
  });

  it('mentions in SKILL.md and README.md only commands and flags the CLI knows', async () => {
    const commands = knownCommands();
    const groups = new Set([...commands].map((name) => name.split(' ')[0]!));
    const flags = knownFlags();
    for (const file of ['skills/taskindex/SKILL.md', 'README.md']) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(
        /`(?:npm run cli -- |taskindex )([a-z]+)(?: ([a-z-]+))?/g,
      )) {
        const [, group, action] = match;
        expect(groups.has(group!), `${file}: taskindex ${group}`).toBe(true);
        if (action && /^[a-z-]+$/.test(action) && !action.startsWith('-'))
          expect(
            commands.has(`${group} ${action}`) || commands.has(group!),
            `${file}: taskindex ${group} ${action}`,
          ).toBe(true);
      }
      if (file.endsWith('SKILL.md'))
        for (const match of text.matchAll(/`(--[a-z-]+)/g))
          expect(flags.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
      expect(text).not.toMatch(/taskindex[^\n]*--json/);
    }
    expect(JSON.stringify(renderHelp())).not.toContain('--json');
  });

  it('SKILL.md teaches the cursor, the confirmation flag, me and the restart rules; .gitattributes marks generated files', async () => {
    const skill = await readFile('skills/taskindex/SKILL.md', 'utf8');
    for (const phrase of [
      'taskindex help',
      'taskindex me',
      'cursor show|commit SEQ|reset',
      '--since last',
      '--commit',
      '--confirm-owner-fields',
      'tasks --today true',
      'tasks --has-follow-up true|false',
      '/api/snapshot',
      '`revoked`',
      'list_changed_during_walk',
      'taskindex inbox',
      'operationSeq',
      'issues[].path',
      'skipped: owner',
    ])
      expect(skill, `SKILL.md: ${phrase}`).toContain(phrase);
    // The removed command is mentioned only as removed, never as a call.
    expect(skill).not.toContain('`taskindex task focus');
    expect(skill).not.toContain('`task focus ');
    const attributes = await readFile('.gitattributes', 'utf8');
    for (const pattern of [
      'drizzle/v2/meta/** linguist-generated=true',
      'docs/reference/**/*-sha256.json linguist-generated=true',
      'docs/reference/**/environment.json linguist-generated=true',
      'docs/audits/** linguist-generated=true',
    ])
      expect(attributes).toContain(pattern);
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('npm run cli -- help task create');
    expect(readme).toContain('--confirm-owner-fields');
  });

  it('refuses the removed --json flag with a hint', async () => {
    const output: Record<string, unknown>[] = [];
    const code = await runCli(['tasks', '--json'], {
      env: { TASKINDEX_URL: 'https://x.example', TASKINDEX_TOKEN: 't' },
      stdout: (line) =>
        output.push(JSON.parse(line) as Record<string, unknown>),
      stderr: () => undefined,
    });
    expect(code).toBe(2);
    expect(output[0]).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      hint: 'вывод всегда JSON, флаг удалён',
    });
  });
});
