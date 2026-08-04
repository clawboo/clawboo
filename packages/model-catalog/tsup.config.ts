import { defineConfig } from 'tsup'

export default defineConfig({
  // Pure, browser-safe barrel: static catalog data + string helpers, zero deps.
  // Bundled into the Vite SPA and inlined into the tsup server bundle alike.
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
