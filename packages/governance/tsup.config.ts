import { defineConfig } from 'tsup'

export default defineConfig({
  // Browser-safe: every export is a pure function or a zod schema (no node:*
  // imports), so the board, the server libs, and the SPA can all consume it.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
