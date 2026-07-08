import { defineConfig } from 'tsup'

export default defineConfig({
  // Framework-agnostic control-plane client: a configurable base URL + auth/tenant
  // header seam wrapping the clawboo server's REST/SSE surface. Browser-safe (uses
  // only fetch / ReadableStream / TextDecoder / AbortController), so the SPA bundles
  // it in the Vite build and a future desktop/mobile/npm shell can import it too.
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
