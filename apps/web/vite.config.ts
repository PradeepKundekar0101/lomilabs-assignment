import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Same-origin /health in dev; in Docker, nginx does this proxying instead.
  server: { proxy: { '/health': process.env.API_URL ?? 'http://localhost:3000' } },
})
