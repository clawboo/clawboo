// GET /api/settings must NEVER return the raw gateway bearer token — the browser
// doesn't need it (the same-origin proxy injects the upstream token server-side),
// and returning it would leak a credential in a response body. The endpoint
// exposes only `hasToken`. Sandboxes CLAWBOO_HOME so the settings file is a throwaway.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { saveSettings } from '@clawboo/config'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The POST path fires a best-effort registry reconnect; stub it so the test never
// dials a real gateway.
vi.mock('../../lib/agentSource', () => ({
  getRegistry: () => ({ reconnect: async () => undefined }),
}))

import { settingsGET, settingsPOST } from '../settings'

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
const req = (): Request => ({ query: {}, params: {} }) as unknown as Request

describe('GET /api/settings — never leaks the raw gateway token', () => {
  let home: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-settings-'))
    // Sandbox every dir the settings loader consults so it reads only our file.
    for (const k of [
      'CLAWBOO_HOME',
      'HOME',
      'OPENCLAW_STATE_DIR',
      'GATEWAY_URL',
      'GATEWAY_AUTH_TOKEN',
    ]) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = home
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = path.join(home, '.openclaw')
    delete process.env['GATEWAY_URL']
    delete process.env['GATEWAY_AUTH_TOKEN']
    // Persist a real (non-template) token so hasToken resolves true.
    saveSettings({
      gatewayUrl: 'ws://localhost:18789',
      gatewayToken: 'super-secret-upstream-token',
    })
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('returns hasToken=true but omits the raw gatewayToken', () => {
    const r = mockRes()
    settingsGET(req(), r.res)

    expect(r.statusCode()).toBe(200)
    const body = r.body() as Record<string, unknown>
    expect(body.hasToken).toBe(true)
    // The leak is closed: the raw token is never present in the response body.
    expect('gatewayToken' in body).toBe(false)
    expect(JSON.stringify(body)).not.toContain('super-secret-upstream-token')
    expect(body).toHaveProperty('gatewayUrl')
    expect(body).toHaveProperty('firstRunDismissedAt')
  })
})

describe('POST /api/settings — validates gatewayUrl before persisting', () => {
  let home: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-settings-post-'))
    for (const k of [
      'CLAWBOO_HOME',
      'HOME',
      'OPENCLAW_STATE_DIR',
      'GATEWAY_URL',
      'GATEWAY_AUTH_TOKEN',
    ]) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = home
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = path.join(home, '.openclaw')
    delete process.env['GATEWAY_URL']
    delete process.env['GATEWAY_AUTH_TOKEN']
  })
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  const post = (body: unknown): Request => ({ body }) as unknown as Request

  for (const bad of [
    'http://evil.example',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
  ]) {
    it(`rejects a non-websocket gatewayUrl (${bad}) with 400`, () => {
      const r = mockRes()
      settingsPOST(post({ gatewayUrl: bad }), r.res)
      expect(r.statusCode()).toBe(400)
    })
  }

  it('accepts and persists a ws:// gatewayUrl', () => {
    const r = mockRes()
    settingsPOST(post({ gatewayUrl: 'ws://localhost:18789' }), r.res)
    expect(r.statusCode()).toBe(200)
    const g = mockRes()
    settingsGET(req(), g.res)
    expect((g.body() as { gatewayUrl?: string }).gatewayUrl).toBe('ws://localhost:18789')
  })

  it('accepts an empty gatewayUrl (clearing)', () => {
    const r = mockRes()
    settingsPOST(post({ gatewayUrl: '' }), r.res)
    expect(r.statusCode()).toBe(200)
  })

  it('ignores a non-string gatewayUrl instead of 500-ing or coercing it', () => {
    settingsPOST(post({ gatewayUrl: 'ws://localhost:18789' }), mockRes().res)
    const r = mockRes()
    settingsPOST(post({ gatewayUrl: 123 }), r.res) // a number — would throw on .trim() pre-guard
    expect(r.statusCode()).toBe(200) // skipped cleanly, not a 500
    const g = mockRes()
    settingsGET(req(), g.res)
    expect((g.body() as { gatewayUrl?: string }).gatewayUrl).toBe('ws://localhost:18789') // unchanged, not "123"
  })

  it('ignores a non-string gatewayToken (never persists a number into the token field)', () => {
    const r = mockRes()
    settingsPOST(post({ gatewayToken: 123 }), r.res)
    expect(r.statusCode()).toBe(200)
    const g = mockRes()
    settingsGET(req(), g.res)
    expect((g.body() as { hasToken?: boolean }).hasToken).toBe(false) // 123 was skipped, not stored as a token
  })
})
