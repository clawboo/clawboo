// Live attach URLs over the real Streamable-HTTP mount. Hermes's gateway
// connects to Clawboo's servers once per agent and keeps the connection across
// runs, so its URL names only the agent (`live=1`, signed). Each call is bound,
// when it arrives, to the run that agent has in progress: its team, its task,
// whether the team engine drives it. The tool list (which the gateway caches for
// the life of its connection) is the widest the agent could need; a call to a
// tool the run in progress is not given is refused by that run's own server.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createTask, teams, agents } from '@clawboo/db'
import { mcpHttpUrl } from '@clawboo/mcp'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { setAgentPageRunner } from '../../lib/logins/browserLink'
import { getMcpAttachSecret } from '../../lib/mcpAttachSecret'
import { bindLiveRun, clearLiveRunBindings } from '../../lib/mcpLiveBindings'
import { openRunRef, resetRunRefsForTests } from '../../lib/runPerson'
import { mcpTasksPost, mcpTasksSession, mcpToolsPost } from '../mcp'

let dir: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-live-http-'))
  process.env['HOME'] = dir
  process.env['CLAWBOO_HOME'] = dir
  expect(getDbPath().startsWith(dir)).toBe(true)
  const db = getDb()
  const now = Date.now()
  db.insert(teams)
    .values({ id: 'team-A', name: 'A', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
    .run()
  db.insert(agents)
    .values({
      id: 'hermes-1',
      name: 'Hermes One',
      gatewayId: 'hermes-1',
      teamId: 'team-A',
      runtime: 'hermes',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const app = express()
  app.use(express.json())
  app.post('/api/mcp/tasks', mcpTasksPost)
  app.get('/api/mcp/tasks', mcpTasksSession)
  app.post('/api/mcp/tools', mcpToolsPost)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => clearLiveRunBindings())
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  rmSync(dir, { recursive: true, force: true })
})

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-03-26',
}

/** One JSON-RPC request with no MCP session, as a live connection sends it. */
async function rpc(
  url: string,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('mcp-session-id')).toBeNull()
  const body = await res.text()
  const line = body.split('\n').find((l) => l.startsWith('data:'))
  return JSON.parse(line ? line.slice('data:'.length) : body) as Record<string, unknown>
}

async function toolNames(url: string): Promise<string[]> {
  const out = (await rpc(url, 'tools/list')) as { result: { tools: { name: string }[] } }
  return out.result.tools.map((t) => t.name).sort()
}

const secret = (): string => getMcpAttachSecret(getDb())
const liveUrl = (agentId = 'hermes-1'): string =>
  mcpHttpUrl(base, 'tasks', { agentId, live: true, attachSecret: secret() })

const EVERY_TOOL = [
  'add_comment',
  'assign_task',
  'block_task',
  'claim_task',
  'create_subtask',
  'create_task',
  'get_task',
  'link_task',
  'list_tasks',
  'release_task',
  'unblock_task',
  'update_task_status',
  'write_plan',
]

describe('live MCP URLs', () => {
  it('names only the agent, under a signature that covers the live mark', () => {
    const url = new URL(liveUrl())
    expect(url.searchParams.get('live')).toBe('1')
    expect(url.searchParams.get('scopeAgentId')).toBe('hermes-1')
    expect(url.searchParams.get('scopeTeamId')).toBeNull()
    expect(url.searchParams.get('scopeTaskId')).toBeNull()
    expect(url.searchParams.get('scopeSig')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lists the widest tool set, whatever run is in progress', async () => {
    const release = bindLiveRun('hermes-1', {
      agentId: 'hermes-1',
      teamId: 'team-A',
      delegate: true,
      attachSecret: secret(),
    })
    expect(await toolNames(liveUrl())).toEqual(EVERY_TOOL)
    release()
    expect(await toolNames(liveUrl())).toEqual(EVERY_TOOL)
  })

  it('lists taskId as optional, so a runtime that checks calls against the list can leave it out', async () => {
    const out = (await rpc(liveUrl(), 'tools/list')) as {
      result: { tools: { name: string; inputSchema: { required?: string[] } }[] }
    }
    for (const name of ['get_task', 'add_comment']) {
      const tool = out.result.tools.find((t) => t.name === name)!
      expect(tool.inputSchema.required ?? []).not.toContain('taskId')
    }
  })

  it("binds a call to the agent's run in progress: its task is the default", async () => {
    const db = getDb()
    const task = createTask(db, { title: 'Parse the logs', teamId: 'team-A', status: 'todo' })
    const release = bindLiveRun('hermes-1', {
      agentId: 'hermes-1',
      teamId: 'team-A',
      boundTaskId: task.id,
      attachSecret: secret(),
    })
    const out = (await rpc(liveUrl(), 'tools/call', { name: 'get_task', arguments: {} })) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    expect(out.result.isError).not.toBe(true)
    expect(out.result.content[0]!.text).toContain('Parse the logs')
    release()
  })

  it('refuses a call the run in progress is not given, even though it was listed', async () => {
    const release = bindLiveRun('hermes-1', {
      agentId: 'hermes-1',
      teamId: 'team-A',
      // A team run: the engine owns its claims and statuses.
      delegate: true,
      attachSecret: secret(),
    })
    const out = (await rpc(liveUrl(), 'tools/call', {
      name: 'claim_task',
      arguments: { taskId: 'x' },
    })) as { result?: { isError?: boolean }; error?: unknown }
    expect(out.error ?? out.result?.isError).toBeTruthy()
    release()
  })

  it('with no run in progress, a call gets no run scope: it is served unbound', async () => {
    // Listed, because the runtime keeps the list across runs...
    expect(await toolNames(liveUrl())).toContain('claim_task')
    // ...but refused when called with nothing in progress.
    const out = (await rpc(liveUrl(), 'tools/call', {
      name: 'claim_task',
      arguments: { taskId: 'x' },
    })) as { result?: { isError?: boolean }; error?: unknown }
    expect(out.error ?? out.result?.isError).toBeTruthy()
  })

  it('serves a URL whose live signature does not cover it as unbound', async () => {
    const unbound = await toolNamesStateful(`${base}/api/mcp/tasks`)
    // Another agent's name on a URL signed for hermes-1.
    const forged = new URL(liveUrl())
    forged.searchParams.set('scopeAgentId', 'someone-else')
    expect(await toolNames(forged.toString())).toEqual(unbound)
    // The live mark stripped from a live URL turns it into a plain per-run URL
    // whose signature does not verify: unbound, not the agent.
    const stripped = new URL(liveUrl())
    stripped.searchParams.delete('live')
    const names = await toolNamesStateful(stripped.toString())
    for (const withheld of ['claim_task', 'assign_task', 'update_task_status'])
      expect(names).not.toContain(withheld)
  })

  it('has no session to stream from: GET is refused', async () => {
    const res = await fetch(liveUrl(), { headers: { accept: 'text/event-stream' } })
    expect(res.status).toBe(405)
  })
})

/** The tool list over an ordinary (session) connection. */
async function toolNamesStateful(url: string): Promise<string[]> {
  const init = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  })
  const sessionId = init.headers.get('mcp-session-id')!
  await init.text()
  const list = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  const body = await list.text()
  const line = body.split('\n').find((l) => l.startsWith('data:'))!
  const parsed = JSON.parse(line.slice('data:'.length)) as { result: { tools: { name: string }[] } }
  return parsed.result.tools.map((t) => t.name).sort()
}

describe('the login fill on a live URL', () => {
  const toolsUrl = (): string =>
    mcpHttpUrl(base, 'tools', { agentId: 'hermes-1', live: true, attachSecret: secret() })

  afterEach(() => {
    setAgentPageRunner(null)
    resetRunRefsForTests()
  })

  it('is listed to the agent, though the list names no run', async () => {
    // A replaced runner counts as a browser the agent holds.
    setAgentPageRunner(async () => ({ kind: 'no_browser' }))
    expect(await toolNames(toolsUrl())).toContain('fill_login')
  })

  it("acts for the person of the run in progress, by that run's reference", async () => {
    setAgentPageRunner(async () => ({ kind: 'no_browser' }))
    const ref = openRunRef('hermes-1', {
      person: { id: 'local', name: 'You', role: null },
      basis: 'started',
    })
    const release = bindLiveRun('hermes-1', {
      agentId: 'hermes-1',
      teamId: 'team-A',
      boundRunRef: ref.ref,
      attachSecret: secret(),
    })
    const out = (await rpc(toolsUrl(), 'tools/call', {
      name: 'fill_login',
      arguments: { site: 'bank.example' },
    })) as { result: { content: { text: string }[] } }
    // Past the person check: the fill went looking for the agent's browser.
    expect(out.result.content[0]!.text).toMatch(/^refused: you have no browser open/)
    release()
    ref.release()
  })
})
