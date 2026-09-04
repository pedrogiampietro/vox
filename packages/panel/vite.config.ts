import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: '/painel/',
  resolve: {
    alias: {
      '@vox/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      '@vox/ui/tokens.css': fileURLToPath(new URL('../ui/tokens.css', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9987' },
    },
  },
  build: { target: 'es2022' },
});
