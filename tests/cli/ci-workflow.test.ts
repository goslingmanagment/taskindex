import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { e2eServers } from '../e2e/helpers';

type Step = { run?: string; shell?: string };
type Job = {
  defaults?: { run?: { shell?: string } };
  steps: Step[];
  strategy?: { matrix?: { include?: Record<string, string>[] } };
};
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  concurrency: Record<string, unknown>;
  defaults?: { run?: { shell?: string } };
  jobs: Record<string, Job>;
};

// `${{ … }}` in a value, for the expressions the concurrency block uses:
// `github.<name>` and string literals compared with ==, joined by && and ||
// (looser), no parentheses. && and || give the deciding operand, as in
// GitHub.
function evaluate(value: unknown, github: Record<string, string>): string {
  const operand = (token: string) => {
    const literal = /^'([^']*)'$/.exec(token.trim())?.[1];
    if (literal !== undefined) return literal;
    const name = /^github\.(\w+)$/.exec(token.trim())?.[1] ?? '';
    if (!Object.hasOwn(github, name))
      throw new Error(`no github.${name} for «${token.trim()}»`);
    return github[name] ?? '';
  };
  const term = (source: string) => {
    const [left = '', right, ...rest] = source.split('==');
    if (rest.length) throw new Error(`«${source}»: one == at most`);
    return right === undefined
      ? operand(left)
      : operand(left) === operand(right);
  };
  const conjunction = (source: string) => {
    let result: string | boolean = true;
    for (const part of source.split('&&')) if (!(result = term(part))) break;
    return result;
  };
  return String(value).replaceAll(/\$\{\{(.*?)\}\}/g, (_, source: string) => {
    let result: string | boolean = false;
    for (const part of source.split('||'))
      if ((result = conjunction(part))) break;
    return String(result);
  });
}

const push = (run_id: string) => ({
  event_name: 'push',
  ref: 'refs/heads/main',
  run_id,
});
const pr = (run_id: string, ref = 'refs/pull/7/merge') => ({
  event_name: 'pull_request',
  ref,
  run_id,
});

async function playwrightConfig() {
  vi.resetModules();
  return (await import('../e2e/playwright.config')).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('.github/workflows/ci.yml and tests/e2e/playwright.config.ts', () => {
  // Playwright runs a leftover test.only alone and passes; in CI that hid
  // every other test of the project behind a green e2e job.
  it('fails e2e on a focused test in CI and allows one locally', async () => {
    vi.stubEnv('CI', 'true');
    expect((await playwrightConfig()).forbidOnly).toBe(true);
    vi.stubEnv('CI', '');
    expect((await playwrightConfig()).forbidOnly).toBe(false);
  });

  // Without pipefail `docker save … | gzip` that failed half way still
  // uploaded a truncated image archive from a green job.
  it('runs every step in bash with pipefail', () => {
    expect(workflow.defaults?.run?.shell).toBe('bash');
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.defaults?.run?.shell ?? 'bash', name).toBe('bash');
      for (const step of job.steps)
        expect(step.shell ?? 'bash', `${name}: ${step.run}`).toBe('bash');
    }
  });

  // release.sh needs a green run on every commit it ships: a push run is
  // never cancelled, a newer push to a pull request cancels the older run.
  it('cancels superseded pull request runs only', () => {
    const { group, 'cancel-in-progress': cancel } = workflow.concurrency;
    expect(evaluate(group, push('1'))).not.toBe(evaluate(group, push('2')));
    expect(evaluate(cancel, push('1'))).toBe('false');
    const tag = { ...push('3'), ref: 'refs/tags/v2.1.0' };
    expect(evaluate(cancel, tag)).toBe('false');
    expect(evaluate(group, pr('4'))).toBe(evaluate(group, pr('5')));
    expect(evaluate(cancel, pr('4'))).toBe('true');
    expect(evaluate(group, pr('4'))).not.toBe(
      evaluate(group, pr('4', 'refs/pull/8/merge')),
    );
  });

  // A Playwright project missing from the e2e matrix never runs in CI. Every
  // project but `setup` (a dependency of the others) is in exactly one entry,
  // or in every shard of one entry, and has its servers in PROJECT_SERVER.
  it('runs every Playwright project in one e2e matrix entry', async () => {
    const projects = (await playwrightConfig()).projects ?? [];
    const names = projects
      .map((project) => project.name ?? '')
      .filter((name) => name !== 'setup');
    const include = workflow.jobs.e2e?.strategy?.matrix?.include ?? [];
    const shards = new Map<string, string[]>();
    for (const entry of include)
      shards.set(entry.projects ?? '', [
        ...(shards.get(entry.projects ?? '') ?? []),
        entry.shard ?? '',
      ]);
    const covered: string[] = [];
    for (const [list, entries] of shards) {
      const total = entries.length;
      expect(entries.toSorted(), list).toEqual(
        Array.from(
          { length: total },
          (_, index) => `${index + 1}/${total}`,
        ).toSorted(),
      );
      covered.push(...list.split(/\s+/).filter(Boolean));
    }
    expect(covered.toSorted()).toEqual(names.toSorted());
    for (const name of names) {
      const servers = e2eServers(name);
      expect(servers.bases.length + Number(servers.static), name).toBe(1);
    }
  });
});
