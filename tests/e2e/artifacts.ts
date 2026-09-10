// Куда e2e пишет скриншоты, environment.json и screenshots-sha256.json.
//
// Обычный `npm run e2e` пишет в `test-results/e2e-artifacts/` (каталог в .gitignore).
// Эталон `docs/reference/v2-validation/` обновляется только осознанно, явной командой:
//
//   TASKINDEX_E2E_ARTIFACT_DIR=docs/reference/v2-validation npm run e2e
//
// После такого прогона снимки просматривают глазами, обновляют README эталона
// (дата `capturedAt` из environment.json) и коммитят вместе с ним. Без переменной
// прогон не должен менять ничего под `docs/`.
export const DEFAULT_E2E_ARTIFACT_DIR = 'test-results/e2e-artifacts';
export const REFERENCE_ARTIFACT_DIR = 'docs/reference/v2-validation';
export function resolveArtifactDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.TASKINDEX_E2E_ARTIFACT_DIR?.trim();
  return explicit ? explicit : DEFAULT_E2E_ARTIFACT_DIR;
}
