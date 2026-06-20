#!/usr/bin/env node
// TeamChat MCP server over stdio. Unbound by default — an external attach passes
// authorAgentId + teamId in the tool args. clawboo's own per-runtime attach binds
// the identity authoritatively via the HTTP URL (the anti-spoof path).
import { createDb, defaultDbPath } from '@clawboo/db'

import { runStdioServer } from '../stdio'
import { createTeamChatServer } from '../teamchat/server'

void (async () => {
  const db = createDb(defaultDbPath())
  await runStdioServer(createTeamChatServer(db))
})()
