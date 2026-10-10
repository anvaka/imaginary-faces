import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the same build works at the site root and under pr-preview/pr-<N>/
  base: './',
  server: { port: 5173, strictPort: true }
});
