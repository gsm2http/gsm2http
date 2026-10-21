import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Backend for `npm run dev`; the UI itself always calls same-origin paths.
const backend = process.env.GSM2HTTP_BACKEND ?? 'http://localhost:9333';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': backend,
      '/healthz': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
});
