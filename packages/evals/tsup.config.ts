import { defineConfig } from 'tsup'

export default defineConfig({
  // Server-only dev/CI harness — depends on @clawboo/db (better-sqlite3), so it
  // never ships in a browser bundle. Not published (private); built so the smoke
  // subset + the nightly runner can run as compiled JS.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
