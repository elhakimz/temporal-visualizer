import { defineConfig } from 'vite';

// Browsers cannot speak gRPC (port 7233), so requests to /api go to the HTTP API served
// by the Temporal UI (port 8233 for `temporal server start-dev`).  The proxy also avoids CORS.
const target = process.env.TEMPORAL_UI ?? 'http://localhost:8233';
const proxy = { '/api': { target, changeOrigin: true } };

// Where "Open in Temporal UI" links point. It is the UI you proxy to unless TEMPORAL_UI_PUBLIC says otherwise
// (useful when the proxy target is a container name your browser cannot resolve).
const publicUi = (process.env.TEMPORAL_UI_PUBLIC ?? target).replace(/\/$/, '');

export default defineConfig({
  define: { __TEMPORAL_UI_URL__: JSON.stringify(publicUi) },
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
  build: { target: 'es2022' },
});
