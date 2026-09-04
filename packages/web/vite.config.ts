import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@vox/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      '@vox/ui/dom.js': fileURLToPath(new URL('../ui/dom.ts', import.meta.url)),
      '@vox/ui/tokens.css': fileURLToPath(new URL('../ui/tokens.css', import.meta.url)),
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
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing.html', import.meta.url)),
        customer: fileURLToPath(new URL('./customer.html', import.meta.url)),
      },
    },
  },
});
