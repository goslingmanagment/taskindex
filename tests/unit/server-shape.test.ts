import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { it, expect } from 'vitest';
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? files(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}
// Plan 06, criterion 1: responsibility-sized modules. 400 lines is the line
// where a file stops fitting one reading; `createApp` only assembles the app.
it('keeps every server module under 400 lines and createApp under 150', () => {
  const tooLong = files(resolve('src/server'))
    .map(
      (path) => [path, readFileSync(path, 'utf8').split('\n').length] as const,
    )
    .filter(([, lines]) => lines > 400);
  expect(tooLong).toEqual([]);
  expect(
    readFileSync(resolve('src/server/app.ts'), 'utf8').split('\n').length,
  ).toBeLessThanOrEqual(150);
});
it('builds every server error response through DomainError instead of inline literals', () => {
  const offenders = files(resolve('src/server')).filter((path) =>
    readFileSync(path, 'utf8').includes('ok: false'),
  );
  expect(offenders).toEqual([]);
});
