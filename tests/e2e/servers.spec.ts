import { test, expect } from '@playwright/test';
import { e2eServers } from './helpers';
// TASKINDEX_E2E_PROJECTS: a CI job starts only the servers of its projects.
function started(raw: string | undefined): string[] {
  const servers = e2eServers(raw);
  return [
    ...servers.bases.map((base) => base.name),
    ...(servers.static ? ['static'] : []),
  ];
}

test('TASKINDEX_E2E_PROJECTS starts only the servers of the listed projects', () => {
  const all = ['main', 'visual', 'dark', 'webkit', 'webkit-dark', 'static'];
  expect(started(undefined)).toEqual(all);
  expect(started(' ')).toEqual(all);
  // The CI matrix: `--project ${{ matrix.projects }}` and the same list here.
  expect(started('functional')).toEqual(['main']);
  expect(started('visual static dark')).toEqual(['visual', 'dark', 'static']);
  expect(started('webkit webkit-dark')).toEqual(['webkit', 'webkit-dark']);
  expect(started('setup,functional')).toEqual(['main']);
  expect(started('static')).toEqual(['static']);
  for (const raw of ['main', 'functional x', 'constructor'])
    expect(() => e2eServers(raw), raw).toThrow(/TASKINDEX_E2E_PROJECTS/);
});
