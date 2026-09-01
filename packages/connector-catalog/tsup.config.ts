import { defineConfig } from 'tsup'

export default defineConfig({
  // Browser-safe and side-effect free: the catalog is plain data plus two lookup
  // maps, so the SPA can render a connector directory with no fetch, no loading
  // state, and no server round-trip, which is the whole point of committing it.
  // TWO ENTRY POINTS, and the split is load-bearing rather than tidy. `index` is
  // the curated directory the SPA imports statically; `community` is the registry
  // snapshot, two orders of magnitude larger, reached only by `await import()`
  // when a user asks for breadth. Bundling them together would put ~35 KB gzipped
  // of servers nobody vetted into the first paint of every install.
  entry: ['src/index.ts', 'src/community.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
