import { defineConfig } from 'tsup'

export default defineConfig({
  // Browser-safe: pure functions, zod schemas, and croner (no node:* imports),
  // so the server libs and a future SPA Scheduler tab can both consume it.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
