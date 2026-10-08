import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 화면 개발용(npm run dev:ui): API·WebSocket 은 wrangler dev(8787)로 넘긴다.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787' },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
