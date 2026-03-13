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
  noExternal: [/^@clawboo\//, 'express', 'cors', 'drizzle-orm', '@noble/ed25519'],
  external: ['better-sqlite3', 'ws', 'pino', 'pino-pretty'],
})
