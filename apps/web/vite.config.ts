import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  build: { outDir: 'dist/ui' },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
})
