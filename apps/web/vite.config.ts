import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4200,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', rewrite: (path) => path.replace(/^\/api/, '') },
      '/socket.io': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: resolve(__dirname, '../../dist/apps/web'), emptyOutDir: true },
  resolve: {
    alias: {
      '@local-agent/agent-protocol': resolve(
        __dirname,
        '../../packages/agent-protocol/src/index.ts',
      ),
    },
  },
});
