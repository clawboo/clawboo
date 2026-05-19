import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // Cover both the React/SPA tests (src/) and the Express-server tests
    // (server/) — we landed the first server-side unit test in v0.1.4 for
    // lib/platform.ts; future server-lib tests should land alongside.
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
