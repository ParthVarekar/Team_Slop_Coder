import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const DAEMON = 'http://127.0.0.1:7421';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/v1': { target: DAEMON, changeOrigin: true },
      '/healthz': { target: DAEMON, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    reportCompressedSize: true,
    chunkSizeWarningLimit: 350,
  },
});
