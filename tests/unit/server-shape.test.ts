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
it('builds every server error response through DomainError instead of inline literals', () => {
  const offenders = files(resolve('src/server')).filter((path) =>
    readFileSync(path, 'utf8').includes('ok: false'),
  );
  expect(offenders).toEqual([]);
});
