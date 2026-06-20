// Host-header injection guard for the team-chat exchange. The REAL
// teamChatExchangePOST handler runs; only the downstream engine is stubbed so we can
// capture the mcpBaseUrl it computed. A forged Host must never reach a spawned
// runtime's MCP attach URL — it comes from the server-bound port (app.locals.apiPort).

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ input: null as Record<string, unknown> | null }))
vi.mock('../../lib/teamChat/runTeamExchange', () => ({
  runTeamExchange: vi.fn(async (input: Record<string, unknown>) => {
    captured.input = input
    return { ok: true, roomId: 'r', turns: [] }
  }),
}))

import { teamChatExchangePOST } from '../teamChat'

function mockRes(): Response & { _status: number; _json?: unknown } {
  const res = {
    _status: 200,
    status(code: number) {
      this._status = code
      return this
    },
    json(body: unknown) {
      ;(this as { _json?: unknown })._json = body
      return this
    },
  }
  return res as unknown as Response & { _status: number; _json?: unknown }
}

const reqEx = (over: Partial<Request>): Request =>
  ({
    body: {},
    get: (() => 'attacker.example') as unknown as Request['get'],
    protocol: 'http',
    on: (() => undefined) as unknown as Request['on'],
    ...over,
  }) as unknown as Request

describe('POST /api/team-chat/exchange — host-header injection', () => {
  let home: string
  let prevHome: string | undefined
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-tchost-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
    captured.input = null
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('uses the server loopback port, never the forged Host header', async () => {
    const res = mockRes()
    await teamChatExchangePOST(
      reqEx({
        body: { teamId: 'tm-x' },
        get: (() => 'attacker.example:1234') as unknown as Request['get'],
        app: { locals: { apiPort: 18790 } } as unknown as Request['app'],
      }),
      res,
    )
    expect(captured.input?.['mcpBaseUrl']).toBe('http://127.0.0.1:18790')
  })

  it('passes a null mcpBaseUrl when the server port is unknown', async () => {
    const res = mockRes()
    await teamChatExchangePOST(reqEx({ body: { teamId: 'tm-y' } }), res)
    expect(captured.input?.['mcpBaseUrl']).toBeNull()
  })
})
