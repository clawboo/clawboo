#!/usr/bin/env node
// Tasks MCP server over stdio. A consuming runtime spawns this; it opens the
// shared clawboo DB (CLAWBOO_DB_PATH override honoured) and serves the board.
import { createDb, defaultDbPath } from '@clawboo/db'

import { runStdioServer } from '../stdio'
import { createTasksServer } from '../tasks/server'

void runStdioServer(createTasksServer(createDb(defaultDbPath())))
