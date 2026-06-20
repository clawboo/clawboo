// ─── Builtin tool descriptors ───────────────────────────────────────────────
// A small set re-expressing real capabilities so the broker has tools to gate,
// inspect, approve, and audit. Executors are intentionally lightweight (the
// point is the broker pipeline, not the tool bodies). Replaces, in time, the
// markdown-bullet skill model — which keeps working in parallel until migrated.

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

export const webSearchTool: ToolDescriptor = {
  name: 'web_search',
  description:
    'Search the web. External side effect → requires approval; hidden until a search provider is configured.',
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().optional() }),
  // Hidden until a provider is configured (env key OR an authed provider).
  availability: { anyOf: [{ env: 'TAVILY_API_KEY' }, { auth: 'tavily' }] },
  owner: 'core',
  risk: 'external',
  executor: (args) => `searched: ${String(args['query'] ?? '')}`,
}

export const deletePathTool: ToolDescriptor = {
  name: 'delete_path',
  description:
    'Delete a path. Destructive → requires approval. (Demo executor — does not actually delete.)',
  inputSchema: z.object({ path: z.string().min(1) }),
  owner: 'core',
  risk: 'destructive',
  executor: (args) => `would delete: ${String(args['path'] ?? '')}`,
}

export const BUILTIN_TOOLS: ToolDescriptor[] = [
  echoTool,
  memoryNoteTool,
  webSearchTool,
  deletePathTool,
]
