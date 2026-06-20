// ─── stdio transport runner ──────────────────────────────────────────────────
// A consuming runtime (Claude Code / Codex / OpenClaw) spawns a bin which calls
// this to serve over stdio. The client owns the process lifecycle.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import type { Server } from './shared'

export async function runStdioServer(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport())
}
