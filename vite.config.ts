import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/socket.io': { target: 'http://localhost:3000', ws: true }, '/api': 'http://localhost:3000' } },
  test: { include: ['shared/**/*.test.ts'] },
} as any);
