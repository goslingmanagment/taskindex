import { defineConfig, devices } from '@playwright/test';
// Three projects: `functional` runs the specs against the Vite dev server
// (API 4001, web 4173); `static` (TI-069) runs the production bundle through
// src/server/index.ts on 4373; `dark` (TI-025) repeats the workspace scenes
// with `prefers-color-scheme: dark`. All start for every run.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 7000 },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  outputDir: '../../test-results',
  projects: [
    { name: 'functional', testIgnore: /(static|dark)\.spec\.ts$/ },
    { name: 'static', testMatch: /static\.spec\.ts$/ },
    // TI-025 шаг 10: те же девять сцен в тёмной теме. Снимки идут в
    // test-results/e2e-dark, эталон светлой темы не трогают.
    {
      name: 'dark',
      testMatch: /dark\.spec\.ts$/,
      use: { colorScheme: 'dark' },
    },
  ],
  webServer: [
    {
      cwd: process.cwd(),
      command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/server.ts',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      cwd: process.cwd(),
      command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/static-server.ts',
      url: 'http://localhost:4373/health',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
