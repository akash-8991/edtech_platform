/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /v1 and /health to the API so the browser sees one origin (no CORS setup needed locally).
// Point it elsewhere with API_TARGET=http://host:port npm run dev
const target = process.env.API_TARGET ?? 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': target, '/health': target } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: false,
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: ['src/test/**', 'src/main.tsx'], reporter: ['text-summary', 'json-summary'] } },
});
