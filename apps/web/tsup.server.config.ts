import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { server: 'server/index.ts' },
  outDir: 'dist',
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  dts: false,
  clean: false,
  sourcemap: false,
  splitting: false,
  // The native runtime's provider SDKs (@anthropic-ai/sdk + openai) are pure-JS
  // HTTP clients and MUST be bundled — a clean `npx clawboo` install ships no
  // node_modules for them, and native is a first-class built-in runtime. They
  // stay lazy-imported in the provider clients, so boot cost is unchanged.
  // croner (the Routines next-occurrence math, pure JS, tiny) rides along the
  // same way — a clean install must schedule without a node_modules for it.
  noExternal: [
    /^@clawboo\//,
    'express',
    // Express middleware has to ship wherever express does. Left external it
    // would be a bare require against a node_modules a clean `npx clawboo`
    // install does not have, and the server would die on boot rather than
    // degrade.
    'express-rate-limit',
    'cors',
    'drizzle-orm',
    '@noble/ed25519',
    '@anthropic-ai/sdk',
    'openai',
    'croner',
  ],
  // OTel is lazy-imported and kept EXTERNAL so it
  // never bloats the bundled dist/server.js; the lazy import resolves it at runtime
  // (dev) or degrades to event-log-only if absent (lean bundled CLI).
  // Declared runtime dependencies of the PUBLISHED package (apps/cli), resolved
  // from node_modules at boot rather than inlined. `@composio/client` joins them
  // rather than being bundled: it is imported statically from the server entry, so
  // it has to be present, and `apps/cli` declaring it is how the other externals
  // here already guarantee that. Bundling it instead broke the Windows build.
  external: [
    'better-sqlite3',
    'ws',
    'pino',
    'pino-pretty',
    '@composio/client',
    /^@opentelemetry\//,
  ],
})
