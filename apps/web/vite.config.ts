/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // Same-origin /api in dev, prefix stripped; in Docker, nginx does this proxying instead.
  server: {
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  // React, Radix, zod and the router are most of the bundle (~190 kB gzipped), fine for an internal review tool.
  build: { chunkSizeWarningLimit: 700 },
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'] },
})
