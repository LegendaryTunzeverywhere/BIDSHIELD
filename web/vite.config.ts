import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'https://bidshield.up.railway.app',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
