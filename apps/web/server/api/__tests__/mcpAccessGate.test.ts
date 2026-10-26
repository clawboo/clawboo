// The /api/mcp/* access gate as the server wires it: the REAL createAccessGate
// with the REAL carriesAttachToken, against URLs minted by clawboo's own
// producers. The headline case is a same-host reverse proxy (nginx, Caddy, a
// Cloudflare Tunnel connector), which delivers every request to the server from
// 127.0.0.1. The gate used to read that loopback peer as "our own spawned
// runtime" and skip the cookie, which put the whole control plane on the
// internet, /api/mcp/config included, and that route signs agent identities.

import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createAccessGate } from '@clawboo/gateway-proxy'
import { REDACTION_MASK } from '@clawboo/logger'
import { MCP_SERVER_NAMES, mcpHttpUrl, signAttachAccess } from '@clawboo/mcp'
import type { Request, Response } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { getMcpAttachSecret, resetMcpAttachSecretCache } from '../../lib/mcpAttachSecret'
import { withAttachSecret } from '../../lib/runtimes'
import { carriesAttachToken, mcpConfigGET, redactAttachCredentials } from '../mcp'

const OPERATOR_TOKEN = 'operator-token-value'
const BASE = 'http://127.0.0.1:18790'
const REMOTE = { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' }

let dir: string
let prevHome: string | undefined
beforeAll(() => {
  prevHome = process.env['CLAWBOO_HOME']
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-mcpgate-'))
  process.env['CLAWBOO_HOME'] = dir
  resetMcpAttachSecretCache()
})
afterAll(() => {
  resetDb()
  resetMcpAttachSecretCache()
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(dir, { recursive: true, force: true })
})

const secret = (): string => getMcpAttachSecret(getDb())
/** The path + query a runtime requests, from a URL exactly as clawboo writes it. */
const requestPath = (url: string): string => url.replace(BASE, '')

function mockReq(
  url: string,
  headers: Record<string, string> = {},
  // Loopback by default, the proxied requests included: that is what a same-host
  // proxy looks like from the server's side of the socket.
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  return {
    url,
    headers: { host: '127.0.0.1:18790', ...headers },
    method: 'POST',
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}

function mockRes(): { res: ServerResponse; status: () => number } {
  const res = { statusCode: 200, setHeader() {}, end() {} } as unknown as ServerResponse
  return { res, status: () => res.statusCode }
}

/** True when the gate let the request through to the route. */
function admitted(gate: ReturnType<typeof createAccessGate>, req: IncomingMessage): boolean {
  const cap = mockRes()
  const handled = gate.handleHttp(req, cap.res)
  if (handled) expect(cap.status()).toBe(401)
  return !handled
}

const gate = createAccessGate({ token: OPERATOR_TOKEN, authorizeRuntime: carriesAttachToken })

describe('the gated control plane behind a same-host reverse proxy', () => {
  it('refuses /api/mcp/config to a remote caller (no more minting identities for strangers)', () => {
    const req = mockReq('/api/mcp/config?server=tools&scopeAgentId=agent-1', REMOTE)
    expect(admitted(gate, req)).toBe(false)
  })

  for (const server of MCP_SERVER_NAMES) {
    it(`refuses a remote caller with no credential on /api/mcp/${server}`, () => {
      expect(admitted(gate, mockReq(`/api/mcp/${server}`, REMOTE))).toBe(false)
    })
  }

  it('refuses a runtime URL replayed through the proxy (a token lifted from a config)', () => {
    const url = mcpHttpUrl(BASE, 'tasks', { teamId: 'T', agentId: 'A', attachSecret: secret() })
    expect(admitted(gate, mockReq(requestPath(url), REMOTE))).toBe(false)
  })

  it('refuses the same URL straight from another host (a wide bind, no proxy at all)', () => {
    const url = mcpHttpUrl(BASE, 'tasks', { teamId: 'T', agentId: 'A', attachSecret: secret() })
    expect(admitted(gate, mockReq(requestPath(url), {}, '192.168.1.50'))).toBe(false)
  })

  it('still lets the operator in with the cookie, through the proxy', () => {
    const req = mockReq('/api/mcp/config?server=tasks', {
      ...REMOTE,
      cookie: `clawboo_access=${OPERATOR_TOKEN}`,
    })
    expect(admitted(gate, req)).toBe(true)
  })
})

describe('spawned runtimes still reach their control plane', () => {
  for (const server of MCP_SERVER_NAMES) {
    it(`admits the scoped URL a driver writes for /api/mcp/${server}`, () => {
      const url = mcpHttpUrl(BASE, server, {
        teamId: 'T',
        agentId: 'A',
        delegate: server === 'teamchat',
        attachSecret: secret(),
      })
      expect(admitted(gate, mockReq(requestPath(url)))).toBe(true)
    })

    it(`admits an unscoped URL (OpenClaw's shape) for /api/mcp/${server}`, () => {
      const url = mcpHttpUrl(BASE, server, { attachSecret: secret() })
      expect(admitted(gate, mockReq(requestPath(url)))).toBe(true)
    })
  }

  it('admits the session follow-ups too: the token rides every request on the URL', () => {
    const url = requestPath(mcpHttpUrl(BASE, 'memory', { agentId: 'A', attachSecret: secret() }))
    expect(admitted(gate, { ...mockReq(url), method: 'GET' } as IncomingMessage)).toBe(true)
    expect(admitted(gate, { ...mockReq(url), method: 'DELETE' } as IncomingMessage)).toBe(true)
  })

  it('admits the verification critic, whose run context carries no scope at all', () => {
    // The critic builds { cwd, model, mcpBaseUrl } and nothing else. The runtime
    // factory fills the secret in, so the URLs its driver writes still pass.
    const ctx = withAttachSecret({ cwd: '/tmp/review', model: null, mcpBaseUrl: BASE })
    expect(ctx.memoryScope?.attachSecret).toBe(secret())
    for (const server of MCP_SERVER_NAMES) {
      const url = mcpHttpUrl(BASE, server, ctx.memoryScope ?? undefined)
      expect(admitted(gate, mockReq(requestPath(url))), server).toBe(true)
    }
  })
})

describe('carriesAttachToken', () => {
  const token = (): string => signAttachAccess(secret())

  it('refuses a missing, foreign or garbage token', () => {
    expect(carriesAttachToken(mockReq('/api/mcp/tasks'))).toBe(false)
    const foreign = signAttachAccess('b'.repeat(64))
    expect(carriesAttachToken(mockReq(`/api/mcp/tasks?attachToken=${foreign}`))).toBe(false)
    expect(carriesAttachToken(mockReq('/api/mcp/tasks?attachToken=not-hex'))).toBe(false)
  })

  it('refuses /api/mcp/config even with a valid token: a runtime must not sign itself an identity', () => {
    expect(carriesAttachToken(mockReq(`/api/mcp/config?attachToken=${token()}`))).toBe(false)
    expect(admitted(gate, mockReq(`/api/mcp/config?scopeAgentId=x&attachToken=${token()}`))).toBe(
      false,
    )
  })

  it('accepts only the exact transport mounts', () => {
    for (const p of ['/api/mcp/tasks/x', '/API/MCP/TASKS', '/api/mcp/', '/api/settings']) {
      expect(carriesAttachToken(mockReq(`${p}?attachToken=${token()}`)), p).toBe(false)
    }
  })

  it('does not read the token from anywhere but the query string', () => {
    const req = mockReq('/api/mcp/tasks', {
      'x-attach-token': token(),
      cookie: `attachToken=${token()}`,
    })
    expect(carriesAttachToken(req)).toBe(false)
  })
})

describe('mcpConfigGET (the operator copy-paste snippet)', () => {
  function snippetUrl(query: Record<string, string>): string {
    let body: { config: { structured: Record<string, { url: string }> } } | undefined
    const req = { query, app: { locals: { apiPort: 18790 } } } as unknown as Request
    const res = {
      json(v: typeof body) {
        body = v
        return this
      },
      status() {
        return this
      },
    } as unknown as Response
    mcpConfigGET(req, res)
    return Object.values(body!.config.structured)[0]!.url
  }

  it('an unscoped snippet carries the attach token, so it works on a gated install', () => {
    const url = snippetUrl({ runtime: 'claude-code', server: 'tasks', transport: 'http' })
    expect(admitted(gate, mockReq(requestPath(url)))).toBe(true)
    expect(url).not.toContain('scopeSig')
  })

  it('a scoped snippet carries both the token and the signed scope', () => {
    const url = snippetUrl({ server: 'tools', scopeAgentId: 'agent-1' })
    expect(url).toContain('scopeSig=')
    expect(admitted(gate, mockReq(requestPath(url)))).toBe(true)
  })
})

describe('redactAttachCredentials (the request log)', () => {
  it('masks the token and both signatures but keeps the rest of the URL', () => {
    const url = requestPath(
      mcpHttpUrl(BASE, 'memory', {
        teamId: 'T',
        agentId: 'A',
        taskId: 't1',
        attachSecret: secret(),
      }),
    )
    const logged = redactAttachCredentials(url)
    expect(logged).not.toContain(signAttachAccess(secret()))
    expect(logged).not.toMatch(/(scopeSig|provSig|attachToken)=[0-9a-f]/)
    expect(logged).toContain('scopeTeamId=T')
    expect(logged).toContain('provTaskId=t1')
    expect(logged.startsWith('/api/mcp/memory?')).toBe(true)
  })

  it('leaves a URL without credentials untouched', () => {
    expect(redactAttachCredentials('/api/settings?x=1')).toBe('/api/settings?x=1')
  })

  it('masks a percent-encoded credential name, which the server still reads as one', () => {
    const token = signAttachAccess(secret())
    const url = `/api/mcp/tasks?scopeTeamId=T&attach%54oken=${token}&scope%53ig=abc#frag`
    expect(new URL(url, BASE).searchParams.get('attachToken')).toBe(token)
    expect(redactAttachCredentials(url)).toBe(
      `/api/mcp/tasks?scopeTeamId=T&attach%54oken=${REDACTION_MASK}&scope%53ig=${REDACTION_MASK}#frag`,
    )
  })

  it('leaves malformed and look-alike names alone', () => {
    const url = '/api/mcp/tasks?attachToken%ZZ=1&attachTokenX=2&%E0%A4%A=3&flag'
    expect(redactAttachCredentials(url)).toBe(url)
  })
})
