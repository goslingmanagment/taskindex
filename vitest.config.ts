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
    include: ['tests/{unit,api,property,web,cli}/**/*.test.{ts,tsx}'],
    testTimeout: 15000,
    hookTimeout: 15000,
    restoreMocks: true,
  },
});
