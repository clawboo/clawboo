// POST /api/system/configure-openclaw mints a gateway token and persists it
// server-side, but must NOT echo it in the response body (the same contract as
// GET /api/settings — the proxy injects the token server-side). Real path: drives
// the actual handler against a sandboxed state dir and inspects both the response
// and the on-disk .env.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configureOpenclawPOST } from '../system'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}

describe('POST /api/system/configure-openclaw — token not echoed', () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-cfg-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR']) saved[k] = process.env[k]
    process.env['CLAWBOO_HOME'] = home
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('persists the token to .env but omits it from the response', () => {
    const r = mockRes()
    configureOpenclawPOST(
      { body: { provider: 'anthropic', apiKey: 'sk-test-key' } } as unknown as Request,
      r.res,
    )

    expect(r.statusCode()).toBe(200)
    const body = r.body() as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['gatewayUrl']).toBe('ws://localhost:18789')
    // The leak is closed — no raw token in the response body.
    expect('gatewayToken' in body).toBe(false)

    // …but the token WAS persisted server-side (the real save happened).
    const env = readFileSync(path.join(stateDir, '.env'), 'utf8')
    const match = env.match(/GATEWAY_AUTH_TOKEN=([a-f0-9]{64})/)
    expect(match).not.toBeNull()
    const persistedToken = match![1]!
    // The persisted token must not appear anywhere in the HTTP response.
    expect(JSON.stringify(body)).not.toContain(persistedToken)
  })
})
