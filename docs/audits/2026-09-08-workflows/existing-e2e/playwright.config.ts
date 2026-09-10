import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'workspace.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  expect: { timeout: 7000 },
  use: {
    baseURL: 'http://localhost:4197',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  outputDir: './results',
  reporter: [['list']],
  webServer: {
    cwd: '/Users/dmitriy/code/taskindex',
    command:
      'node node_modules/tsx/dist/cli.mjs docs/audits/2026-09-08-workflows/existing-e2e/server.ts',
    url: 'http://127.0.0.1:4197',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
