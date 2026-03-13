import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths({ ignoreConfigErrors: true })],
  build: { outDir: 'dist/ui' },
  server: {
    port: 5173,
    proxy: {
      '/api/gateway/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
    },
  },
})
