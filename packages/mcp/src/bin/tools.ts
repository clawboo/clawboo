#!/usr/bin/env node
// Tools-broker MCP server over stdio. Availability is evaluated from the bin's
// env at boot (only satisfied tools register); calls run the full broker
// pipeline (inspector chain → DB-mediated approval → execute → compact → audit).
import { createDb, defaultDbPath } from '@clawboo/db'

import { runStdioServer } from '../stdio'
import { createToolsServer } from '../tools/server'

void runStdioServer(createToolsServer(createDb(defaultDbPath())))
