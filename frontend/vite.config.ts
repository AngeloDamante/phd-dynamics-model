import { defineConfig } from 'vite';

// In dev, the FastAPI backend runs on :8000 (python -m simnode.api).
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', ws: true },
    },
  },
});
