import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: { index: 'src/server/index.ts' },
    outDir: 'dist/server',
    format: 'esm',
    fixedExtension: false,
    target: 'node24',
    sourcemap: true,
    clean: true,
  },
  {
    entry: { index: 'src/cli/index.ts', admin: 'src/cli/admin.ts' },
    outDir: 'dist/cli',
    format: 'esm',
    fixedExtension: false,
    target: 'node24',
    sourcemap: true,
    clean: true,
  },
]);
