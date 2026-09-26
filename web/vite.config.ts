import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The Worker runs on 8788 in development; in production the dashboard and
    // the API sit behind the same Cloudflare Access policy.
    proxy: { '/api': 'http://127.0.0.1:8788' },
  },
  build: { outDir: 'dist' },
});
