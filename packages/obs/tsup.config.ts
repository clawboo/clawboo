import { defineConfig } from 'tsup'

export default defineConfig({
  // Browser-safe: every export is a pure function or a zod schema (no node:*
  // imports), so @clawboo/db, the server obs libs, packages/evals, and the SPA
  // can all consume it. The OTel SDK is NEVER imported here — it is lazy-loaded
  // server-side (apps/web/server/lib/obs) only when an OTLP endpoint is configured.
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
