import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@vox/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Em dev o cliente fala com a mesma origem; o Vite repassa para o servidor.
    proxy: {
      '/vox': { target: 'ws://127.0.0.1:9987', ws: true },
      '/health': { target: 'http://127.0.0.1:9987' },
    },
  },
  build: { target: 'es2022' },
});
