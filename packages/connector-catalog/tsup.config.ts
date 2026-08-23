import { defineConfig } from 'tsup'

export default defineConfig({
  // Browser-safe and side-effect free: the catalog is plain data plus two lookup
  // maps, so the SPA can render a connector directory with no fetch, no loading
  // state, and no server round-trip, which is the whole point of committing it.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
