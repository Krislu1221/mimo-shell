import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const UPSTREAM = process.env.MIMO_UPSTREAM || 'http://127.0.0.1:4096'

export default defineConfig({
  // `new URL(...).pathname` percent-encodes non-ASCII segments, which breaks
  // any checkout living under a path with Chinese characters. fileURLToPath
  // keeps the real filesystem path.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5179,
    // Dev-only convenience: the same `/api` prefix the production gateway uses,
    // pointed at a running `mimo serve`.
    proxy: {
      '/api': {
        target: UPSTREAM,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
