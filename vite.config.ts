import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.VK_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: { host: true, port: 4173 },
});
