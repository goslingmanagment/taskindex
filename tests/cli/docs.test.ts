import { readFile, readlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HELP, runCli } from '../../src/cli/run.js';

// Documentation that agents follow must not drift from the CLI and the pins.
describe('documentation against the code', () => {
  it('pins one Node version everywhere and points AGENTS.md at CLAUDE.md', async () => {
    const nodeVersion = (await readFile('.node-version', 'utf8')).trim();
    expect((await readFile('.nvmrc', 'utf8')).trim()).toBe(nodeVersion);
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe('>=24.11.0 <25');
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

  it('mentions in SKILL.md only commands and flags the CLI knows', async () => {
    const skill = await readFile('skills/taskindex/SKILL.md', 'utf8');
    const help = JSON.stringify(HELP);
    const commands = new Set<string>();
    for (const match of skill.matchAll(/`taskindex ([a-z]+)(?: ([a-z-]+))?/g))
      commands.add(match[2] ? `${match[1]} ${match[2]}` : match[1]!);
    for (const command of commands) {
      const [group, action] = command.split(' ');
      const known = [...HELP.reads, ...HELP.writes].some(
        (line) =>
          line.startsWith(`${group} `) ||
          line === group ||
          line.startsWith(`${group}`) ||
          line.includes(`${group} ${action ?? ''}`),
      );
      expect(known, `SKILL.md: taskindex ${command}`).toBe(true);
      if (action)
        expect(
          [...HELP.reads, ...HELP.writes].some(
            (line) =>
              line.includes(`${group} ${action}`) ||
              (line.startsWith(`${group} `) && line.includes(action)),
          ),
          `SKILL.md: taskindex ${command}`,
        ).toBe(true);
    }
    const flags = new Set(
      [...skill.matchAll(/`(--[a-z-]+)/g)].map((match) => match[1]!),
    );
    for (const flag of flags)
      expect(help.includes(flag), `SKILL.md: ${flag}`).toBe(true);
    expect(skill).not.toContain('--json');
    expect(await readFile('README.md', 'utf8')).not.toMatch(
      /taskindex[^\n]*--json/,
    );
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
