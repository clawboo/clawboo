// TeamChat over the real Streamable-HTTP mount. Unbound, its two tools take the
// author and room from tool arguments, so the HTTP handler must treat a session
// with no verified binding as an unverified caller and serve neither tool. Driven
// over a real socket so the wiring in `getHandlers` is what is under test, not a
// stand-in for it.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { mcpHttpUrl } from '@clawboo/mcp'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { getMcpAttachSecret } from '../../lib/mcpAttachSecret'
import { mcpTeamchatPost } from '../mcp'

let dir: string
let prevHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-teamchat-http-'))
  process.env['CLAWBOO_HOME'] = dir
  const app = express()
  app.use(express.json())
  app.post('/api/mcp/teamchat', mcpTeamchatPost)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(dir, { recursive: true, force: true })
})

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}
const VERSION = '2025-03-26'

/** Open a session on `url` and return the tool names it lists. */
async function toolNames(url: string): Promise<string[]> {
  const init = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: VERSION,
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  })
  expect(init.status).toBe(200)
  const sessionId = init.headers.get('mcp-session-id')!
  await init.text()
  const list = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  // A Streamable-HTTP POST answers as an SSE stream: the JSON-RPC result is the
  // `data:` line.
  const body = await list.text()
  const line = body.split('\n').find((l) => l.startsWith('data:'))!
  const parsed = JSON.parse(line.slice('data:'.length)) as { result: { tools: { name: string }[] } }
  return parsed.result.tools.map((t) => t.name)
}

const secret = (): string => getMcpAttachSecret(getDb())

describe('TeamChat over HTTP', () => {
  it('serves NO tools to a session with no binding (the critic, a teamless run)', async () => {
    expect(await toolNames(mcpHttpUrl(base, 'teamchat', { attachSecret: secret() }))).toEqual([])
    // An author but no room: what a run for a task without a team carries.
    const authorOnly = mcpHttpUrl(base, 'teamchat', { agentId: 'agent-1', attachSecret: secret() })
    expect(await toolNames(authorOnly)).toEqual([])
  })

  it('serves no tools to a binding whose signature does not verify', async () => {
    const forged = `${base}/api/mcp/teamchat?roomTeamId=team-A&postAuthorAgentId=victim&scopeSig=${'ab'.repeat(32)}`
    expect(await toolNames(forged)).toEqual([])
  })

  it('serves both tools to a clawboo-signed binding', async () => {
    const url = mcpHttpUrl(base, 'teamchat', {
      teamId: 'team-A',
      agentId: 'agent-1',
      attachSecret: secret(),
    })
    expect(await toolNames(url)).toEqual(['team_chat_post', 'team_chat_subscribe'])
  })
})
