import { defineConfig, devices } from '@playwright/test';
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
  webServer: {
    cwd: process.cwd(),
    command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/server.ts',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
