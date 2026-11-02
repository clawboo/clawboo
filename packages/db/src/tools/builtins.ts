// ─── Builtin tool descriptors ───────────────────────────────────────────────
// The tools every agent gets from clawboo's own tools server, before any
// connector. Each one must do what its name says: an agent cannot tell a demo
// executor from a real one. `web_search` (which echoed the query back) and
// `delete_path` (which deleted nothing) were removed for that reason; web search
// comes from the search connectors, which run under grants like any other.

import { z } from 'zod'

import type { ToolDescriptor } from './types'

export const echoTool: ToolDescriptor = {
  name: 'echo',
  description: 'Echo a message back. Safe, no side effects — used to prove the round-trip.',
  inputSchema: z.object({ message: z.string() }),
  owner: 'core',
  risk: 'safe',
  executor: (args) => String(args['message'] ?? ''),
}

export const memoryNoteTool: ToolDescriptor = {
  name: 'note',
  description: 'Record a short note. Safe.',
  inputSchema: z.object({ note: z.string().min(1) }),
  owner: 'core',
  risk: 'safe',
  executor: (args) => `noted: ${String(args['note'] ?? '')}`,
}

export const BUILTIN_TOOLS: ToolDescriptor[] = [echoTool, memoryNoteTool]
