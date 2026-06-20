// /api/health is run through redactObject (consistent with obs/audit/tools): a
// credential-shaped substring that lands in a boot-check detail is masked, while
// the readable diagnostics (paths, config) survive.

import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

const SECRET = 'sk-test-0123456789abcdefSECRET'

const REPORT = {
  ok: false,
  generatedAt: 0,
  checks: [
    {
      id: 'openclawGatewayReachable',
      ok: false,
      message: 'connect failed',
      detail: `boom: Bearer ${SECRET}`,
      durationMs: 1,
    },
    {
      id: 'clawbooHomeWritable',
      ok: true,
      message: 'writable',
      detail: '/home/u/.clawboo',
      durationMs: 1,
    },
  ],
  degraded: ['openclawGatewayReachable'],
  fatal: [],
  config: { budgetPosture: 'track-and-warn' },
  resolved: {
    apiPort: 18790,
    clawbooHome: '/home/u/.clawboo',
    dbPath: '/home/u/.clawboo/clawboo.db',
  },
}

vi.mock('../../lib/bootProbe', () => ({
  getLastBootReport: () => REPORT,
  runBootProbe: vi.fn(),
}))
vi.mock('../../lib/portUtils', () => ({ readApiPortFile: () => 18790 }))

import { healthGET } from '../health'

function mockRes(): { res: Response; body: () => unknown } {
  let payload: unknown
  const res = {
    status() {
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, body: () => payload }
}

describe('health redact-on-display', () => {
  it('masks a credential-shaped substring in a check detail; keeps the readable paths', () => {
    const r = mockRes()
    healthGET({} as Request, r.res)
    const body = JSON.stringify(r.body())
    expect(body).not.toContain(SECRET) // the secret is masked
    expect(body).toContain('••••')
    expect(body).toContain('/home/u/.clawboo') // diagnostics paths survive
  })
})
