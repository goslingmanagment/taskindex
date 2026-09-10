import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
    watch: { useFsEvents: false, usePolling: true },
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
  build: { outDir: 'dist/web', emptyOutDir: true },
});
