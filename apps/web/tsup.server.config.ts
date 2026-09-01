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
    // The Composio API client, for the same reason as the provider SDKs: it is a
    // pure-JS HTTP client with zero dependencies, and `connectors/composio` is
    // imported STATICALLY from the server entry, so a clean `npx clawboo` install
    // that could not resolve it would fail to boot rather than lose one connector.
    // Bundling also pins it, which matters more than usual while it is an alpha.
    '@composio/client',
  ],
  // OTel is lazy-imported and kept EXTERNAL so it
  // never bloats the bundled dist/server.js; the lazy import resolves it at runtime
  // (dev) or degrades to event-log-only if absent (lean bundled CLI).
  external: ['better-sqlite3', 'ws', 'pino', 'pino-pretty', /^@opentelemetry\//],
})
