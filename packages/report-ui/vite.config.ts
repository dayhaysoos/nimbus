import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  server: {
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
