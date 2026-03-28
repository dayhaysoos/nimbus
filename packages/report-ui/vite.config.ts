import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

function createApiProxy() {
  const apiKey = process.env.NIMBUS_API_KEY?.trim();

  return {
    target: process.env.NIMBUS_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
    changeOrigin: true,
    configure: (proxy: {
      on: (event: 'proxyReq', listener: (proxyReq: { setHeader: (name: string, value: string) => void }) => void) => void;
    }) => {
      if (!apiKey) {
        return;
      }
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.setHeader('X-Nimbus-Api-Key', apiKey);
      });
    },
  };
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: process.env.VITE_HOST ?? 'localhost',
    port: process.env.VITE_PORT ? Number(process.env.VITE_PORT) : undefined,
    strictPort: Boolean(process.env.VITE_PORT),
    proxy: {
      '/api': createApiProxy(),
    },
  },
  preview: {
    proxy: {
      '/api': createApiProxy(),
    },
  },
});
