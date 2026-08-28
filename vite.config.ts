import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  plugins: [react(), tailwindcss(), sites()],
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            { name: 'charts', test: /node_modules\/echarts/ },
            { name: 'renderer', test: /node_modules\/zrender/ },
            { name: 'motion', test: /node_modules\/(motion|framer-motion|@motionone)/ },
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler|@radix-ui)/ },
          ],
        },
      },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
