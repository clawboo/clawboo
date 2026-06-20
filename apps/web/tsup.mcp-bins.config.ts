import { defineConfig } from 'tsup'

// Bundle the @clawboo/mcp stdio bins SELF-CONTAINED (the SDK + @clawboo/db +
// drizzle inlined) so they ship in the lean `npx clawboo` tarball and run from a
// clean install — an external runtime spawns `clawboo-mcp-tasks` etc. Same
// externals as the server bundle: only native / process-level deps stay external
// (resolved from the CLI's installed deps), and OTel stays external + lazy so the
// bins never require it at boot. The bin source's `#!/usr/bin/env node` shebang is
// preserved (tsup keeps a leading shebang — no banner needed).
export default defineConfig({
  entry: {
    tasks: '../../packages/mcp/src/bin/tasks.ts',
    memory: '../../packages/mcp/src/bin/memory.ts',
    tools: '../../packages/mcp/src/bin/tools.ts',
    teamchat: '../../packages/mcp/src/bin/teamchat.ts',
  },
  outDir: 'dist/mcp',
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  dts: false,
  clean: false,
  sourcemap: false,
  splitting: false,
  noExternal: [/^@clawboo\//, 'drizzle-orm', '@noble/ed25519', /^@modelcontextprotocol\//],
  external: ['better-sqlite3', 'ws', 'pino', 'pino-pretty', /^@opentelemetry\//],
})
