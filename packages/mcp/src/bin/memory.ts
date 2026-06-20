#!/usr/bin/env node
// Memory MCP server over stdio. Resolves an embedding provider once at boot
// (Ollama → OpenAI → none); vector/hybrid search degrades to FTS when none.
import { createDb, defaultDbPath, resolveEmbeddingProvider } from '@clawboo/db'

import { createMemoryServer } from '../memory/server'
import { runStdioServer } from '../stdio'

void (async () => {
  const db = createDb(defaultDbPath())
  const embed = await resolveEmbeddingProvider().catch(() => null)
  await runStdioServer(createMemoryServer(db, embed))
})()
