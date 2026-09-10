import { defineConfig, devices } from '@playwright/test';
// Two fixtures: `functional` runs the specs against the Vite dev server
// (API 4001, web 4173); `static` (TI-069) runs the production bundle through
// src/server/index.ts on 4373. Both start for every run.
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
    { name: 'functional', testIgnore: /static\.spec\.ts$/ },
    { name: 'static', testMatch: /static\.spec\.ts$/ },
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
