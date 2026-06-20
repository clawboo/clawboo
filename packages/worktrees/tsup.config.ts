import { defineConfig } from 'tsup'

export default defineConfig({
  // Server-only library: a single barrel. Shells out to the `git` CLI via
  // node:child_process and writes the system-of-record scaffold via
  // node:fs/promises, so it never ships in the browser bundle.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
