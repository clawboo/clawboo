#!/usr/bin/env node
// Memory MCP server over stdio. The embedding provider follows the dashboard's
// rules and is re-resolved once a minute (see createStdioEmbedSource); with no
// provider, vector and hybrid search degrade to keyword search.
import { createDb, defaultDbPath } from '@clawboo/db'

import { createMemoryServer } from '../memory/server'
import { createStdioEmbedSource } from '../memory/stdioEmbedSource'
import { runStdioServer } from '../stdio'

void (async () => {
  const db = createDb(defaultDbPath())
  await runStdioServer(createMemoryServer(db, createStdioEmbedSource(db)))
})()
