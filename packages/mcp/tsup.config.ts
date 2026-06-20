import { defineConfig } from 'tsup'

export default defineConfig({
  // The barrel (server factories + the in-process Streamable-HTTP mount + the
  // attach-config helper) plus three stdio bin entries. Server-only: opens the
  // shared SQLite DB and speaks MCP — never ships in the browser bundle. The MCP
  // SDK + @clawboo/db are externalised (resolved from the installed package).
  entry: {
    index: 'src/index.ts',
    'bin/tasks': 'src/bin/tasks.ts',
    'bin/memory': 'src/bin/memory.ts',
    'bin/tools': 'src/bin/tools.ts',
    'bin/teamchat': 'src/bin/teamchat.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@clawboo/db', '@modelcontextprotocol/sdk'],
})
