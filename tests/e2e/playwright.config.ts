import { defineConfig, devices } from '@playwright/test';
import { BASE } from './helpers';
// Смоук основных сценариев на одной чистой базе (`tests/e2e/server.ts`):
// * `setup` — вход владельца по паролю, сессия уходит в `storageState`;
// * `functional` — остальные спеки с этой сессией (порты 4001/4173 в слоте 0,
//   см. TASKINDEX_E2E_SLOT в `helpers.ts`).
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // Playwright's default lets a leftover `test.only` run alone and exit 0,
  // which in CI hid the rest of the project behind a green job. Locally
  // `.only` stays allowed.
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 7000 },
  use: {
    baseURL: BASE.url,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  outputDir: '../../test-results',
  projects: [
    { name: 'setup', testMatch: /setup\.spec\.ts$/ },
    {
      name: 'functional',
      dependencies: ['setup'],
      testIgnore: /setup\.spec\.ts$/,
      use: { storageState: BASE.storageState },
    },
  ],
  webServer: [
    {
      cwd: process.cwd(),
      command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/server.ts',
      url: BASE.url,
      reuseExistingServer: false,
      // 90 с не хватало, когда ПК CI был перегружен (29.09): сервер поднимался
      // дольше и e2e падал, не начав тестов.
      timeout: 180000,
      env: {
        TASKINDEX_E2E_BASE: BASE.name,
        TASKINDEX_E2E_API_PORT: String(BASE.api),
        TASKINDEX_E2E_WEB_PORT: String(BASE.web),
      },
    },
  ],
});
