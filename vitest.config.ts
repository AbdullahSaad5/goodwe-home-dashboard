import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./web/src/test/setup.ts'],
    css: false,
  },
});
