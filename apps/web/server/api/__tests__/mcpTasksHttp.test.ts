// Tasks over the real Streamable-HTTP mount: which board tools each kind of run
// is served, read from the URL clawboo wrote for it. A run the team engine drives
// gets no tool that moves another card (the engine owns its claims and statuses),
// an OpenClaw agent's unsigned URL gets no status write at all, and every other
// signed run keeps the full set. Driven over a real socket so the wiring in
// `getHandlers` is what is under test.

import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { claimTask, createTask, getTask } from '@clawboo/db'
import { mcpHttpUrl } from '@clawboo/mcp'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { getMcpAttachSecret } from '../../lib/mcpAttachSecret'
import { mcpTasksPost } from '../mcp'

let dir: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
let server: http.Server
let base: string

beforeAll(async () => {
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-tasks-http-'))
  process.env['HOME'] = dir
  process.env['CLAWBOO_HOME'] = dir
  expect(getDbPath().startsWith(dir)).toBe(true)
  const app = express()
  app.use(express.json())
  app.post('/api/mcp/tasks', mcpTasksPost)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
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
}
const VERSION = '2025-03-26'

/** Open a session on `url` and return the tool names it lists, sorted. */
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
  return parsed.result.tools.map((t) => t.name).sort()
}

const secret = (): string => getMcpAttachSecret(getDb())

const MOVES_NO_CARD = [
  'add_comment',
  'create_subtask',
  'create_task',
  'get_task',
  'link_task',
  'list_tasks',
]

describe('Tasks over HTTP', () => {
  it('serves a team run (the URL serverDeliver writes) no tool that moves another card', async () => {
    const url = mcpHttpUrl(base, 'tasks', {
      teamId: 'team-A',
      agentId: 'coder',
      delegate: true,
      attachSecret: secret(),
    })
    expect(await toolNames(url)).toEqual(
      [...MOVES_NO_CARD.filter((name) => name !== 'link_task'), 'block_task'].sort(),
    )
  })

  it('serves every tool to a signed run the engine does not drive (the task runner)', async () => {
    const url = mcpHttpUrl(base, 'tasks', {
      teamId: 'team-A',
      agentId: 'coder',
      attachSecret: secret(),
    })
    expect(await toolNames(url)).toEqual(
      [
        ...MOVES_NO_CARD,
        'assign_task',
        'block_task',
        'claim_task',
        'release_task',
        'unblock_task',
        'update_task_status',
      ].sort(),
    )
  })

  it('serves a one-to-one chat the reads and add_comment (the URL a chat turn writes)', async () => {
    const url = mcpHttpUrl(base, 'tasks', {
      teamId: null,
      agentId: 'boo-zero',
      chatRun: true,
      chatRunTeamId: null,
      attachSecret: secret(),
    })
    expect(await toolNames(url)).toEqual(['add_comment', 'get_task', 'list_tasks'])
  })

  it('serves a chat’s Memory signature on Tasks as what it is: no one in particular', async () => {
    const memory = new URL(
      mcpHttpUrl(base, 'memory', {
        teamId: null,
        agentId: 'coder',
        chatRun: true,
        chatRunTeamId: 'team-A',
        attachSecret: secret(),
      }),
    )
    const replayed = new URL(`${base}/api/mcp/tasks`)
    replayed.searchParams.set('scopeAgentId', 'coder')
    replayed.searchParams.set('chatRun', '1')
    replayed.searchParams.set('scopeSig', memory.searchParams.get('scopeSig')!)
    expect(await toolNames(replayed.toString())).toEqual(await toolNames(`${base}/api/mcp/tasks`))
  })

  it("never serves a chat every tool through its own Tools or Memory URL's signature", async () => {
    const scope = {
      teamId: null,
      agentId: 'boo-zero',
      chatRun: true,
      chatRunTeamId: null,
      attachSecret: secret(),
    }
    for (const server of ['tools', 'memory'] as const) {
      const repointed = mcpHttpUrl(base, server, scope).replace(
        `/api/mcp/${server}`,
        '/api/mcp/tasks',
      )
      const names = await toolNames(repointed)
      for (const withheld of ['claim_task', 'assign_task', 'update_task_status', 'release_task'])
        expect(names, `${server} URL served ${withheld}`).not.toContain(withheld)
    }
  })

  it("never serves a team run every tool through its own Tools or Memory URL's signature", async () => {
    // Every URL a team run holds signs its team and agent. A Tools or Memory
    // signature that did not cover the team-run mark would read, on the Tasks
    // mount, as a run the engine does not drive, with all 12 tools.
    const scope = { teamId: 'team-A', agentId: 'coder', delegate: true, attachSecret: secret() }
    for (const server of ['tools', 'memory'] as const) {
      const repointed = mcpHttpUrl(base, server, scope).replace(
        `/api/mcp/${server}`,
        '/api/mcp/tasks',
      )
      const names = await toolNames(repointed)
      for (const withheld of ['claim_task', 'assign_task', 'update_task_status', 'release_task'])
        expect(names, `${server} URL served ${withheld}`).not.toContain(withheld)
    }
  })

  it('blocks the bound task of a task runner run when block_task names none', async () => {
    expect(getDbPath().startsWith(dir)).toBe(true)
    const db = getDb()
    const task = createTask(db, { title: 'Write the parser', teamId: 'team-A', status: 'todo' })
    expect(claimTask(db, task.id, 'coder', 'claude-code').ok).toBe(true)
    // The URL the runner writes: signed, not a team run, with the run's own task.
    const url = mcpHttpUrl(base, 'tasks', {
      teamId: 'team-A',
      agentId: 'coder',
      boundTaskId: task.id,
      attachSecret: secret(),
    })
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
    const sessionId = init.headers.get('mcp-session-id')!
    await init.text()
    const call = await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'block_task', arguments: { waitingOn: 'person', need: 'A key' } },
      }),
    })
    await call.text()
    expect(getTask(db, task.id)?.status).toBe('blocked')
  })

  it("serves an unsigned URL (every OpenClaw agent's) no claim and no status write", async () => {
    expect(await toolNames(mcpHttpUrl(base, 'tasks', { attachSecret: secret() }))).toEqual(
      MOVES_NO_CARD,
    )
  })
})
