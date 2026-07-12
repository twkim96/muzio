import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Vite dev server proxies /api/* and /healthz to the Go backend so the browser
// always sees a single origin during development. Production serving from the
// backend keeps this assumption for release builds.
//
// The proxy target defaults to the backend's documented dev address. Set
// VMA_DEV_BACKEND in the shell to point at a different port (handy when 7777
// is taken on the dev machine).
const backendTarget = process.env.VMA_DEV_BACKEND ?? 'http://127.0.0.1:7777';
const devHost = process.env.VMA_DEV_HOST ?? '0.0.0.0';
const allowedHosts = process.env.VMA_DEV_ALLOWED_HOSTS
  ?.split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0);

function devHttpsOptions() {
  if (process.env.VMA_DEV_HTTPS !== '1') return undefined;

  const certPath = process.env.VMA_DEV_TLS_CERT;
  const keyPath = process.env.VMA_DEV_TLS_KEY;
  if (!certPath || !keyPath) {
    throw new Error(
      'VMA_DEV_HTTPS=1 requires VMA_DEV_TLS_CERT and VMA_DEV_TLS_KEY',
    );
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: devHost,
    allowedHosts,
    https: devHttpsOptions(),
    port: 5173,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: false,
      },
      '/healthz': {
        target: backendTarget,
        changeOrigin: false,
      },
    },
  },
});
