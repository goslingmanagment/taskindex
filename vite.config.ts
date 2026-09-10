import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// TI-066 (план 07, шаг 18). macOS Seatbelt (песочница Codex) не отдаёт FSEvents,
// и без опроса Vite не видит правок вовсе. Вне песочницы опрос каждые сто
// миллисекунд греет процессор без нового сигнала, поэтому он включается только
// по признаку песочницы или явным TASKINDEX_VITE_POLLING=1.
const usePolling =
  process.env.CODEX_SANDBOX === 'seatbelt' ||
  process.env.TASKINDEX_VITE_POLLING === '1';

// TI-066. Vite сам игнорирует node_modules, .git, test-results и outDir; здесь
// добавлены каталоги, которые пишет не разработчик, а сам стенд: рабочая база
// вместе с -wal/-shm, отчёты Playwright и покрытие. Запись в них не должна
// перезапускать HMR.
const ignored = ['**/data/**', '**/playwright-report/**', '**/coverage/**'];

// TI-066, TI-024 (план 07, §3.10). Вендорные группы вынесены из чанка
// приложения: обновление кода перестаёт сбрасывать их кэш у браузера, а размер
// каждой группы становится видимым в выводе сборки. Ключ — имя пакета из пути
// node_modules, поэтому `react` не ловит `react-dom`.
const VENDOR_CHUNKS: Record<string, string> = {
  react: 'react',
  'react-dom': 'react',
  scheduler: 'react',
  '@base-ui/react': 'base-ui',
  '@floating-ui/dom': 'base-ui',
  '@floating-ui/core': 'base-ui',
  '@floating-ui/utils': 'base-ui',
  '@floating-ui/react-dom': 'base-ui',
  '@dnd-kit/core': 'dnd-kit',
  '@dnd-kit/sortable': 'dnd-kit',
  '@dnd-kit/utilities': 'dnd-kit',
  '@dnd-kit/accessibility': 'dnd-kit',
  zod: 'zod',
  '@hono/zod-openapi': 'zod',
  'better-auth': 'auth',
  '@better-auth/passkey': 'auth',
  '@simplewebauthn/browser': 'auth',
  '@simplewebauthn/types': 'auth',
  'lucide-react': 'icons',
};

function vendorChunk(id: string): string | undefined {
  const tail = id.split('/node_modules/').at(-1);
  if (tail === undefined || tail === id) return undefined;
  const [scopeOrName = '', second = ''] = tail.split('/');
  const name = scopeOrName.startsWith('@')
    ? `${scopeOrName}/${second}`
    : scopeOrName;
  return VENDOR_CHUNKS[name];
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/web', import.meta.url)),
      '@web': fileURLToPath(new URL('./src/web', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: usePolling ? { ignored, usePolling: true } : { ignored },
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    // TI-024: карты собираются по требованию — `TASKINDEX_SOURCEMAP=1 npm run
    // build` для разбора веса чанков (source-map-explorer). План 07 §3.10 просил
    // 'hidden' по умолчанию, но там это опиралось на удаление `*.map` в
    // рантайм-стадии `deploy/Dockerfile` (план 11), которого ещё нет: сейчас
    // 'hidden' положил бы в образ ~3,6 МБ карт веб-клиента. Вернуть 'hidden'
    // после того, как Dockerfile начнёт их вычищать.
    sourcemap: Boolean(process.env.TASKINDEX_SOURCEMAP),
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
});
