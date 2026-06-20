import { defineConfig } from 'tsup'

export default defineConfig({
  // Browser-safe: the compactor runs client-side (the adapter + tool-result
  // flow live in a React hook). No node:* imports, no `external` — everything
  // is pure string transforms, so the bundle is self-contained.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
