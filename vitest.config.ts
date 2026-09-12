import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/web', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Node 26 exposes a `localStorage` getter that throws without
    // `--localstorage-file` and prints an ExperimentalWarning per worker.
    // Unit tests run without browser storage, as they did under Node 24 (TI-084).
    execArgv: ['--no-experimental-webstorage'],
    include: ['tests/{unit,api,property,web,cli,deploy}/**/*.test.{ts,tsx}'],
    testTimeout: 15000,
    hookTimeout: 15000,
    restoreMocks: true,
  },
});
