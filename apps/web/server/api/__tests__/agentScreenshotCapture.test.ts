// A failed capture answers JSON. The Browser panel reads the body of this route,
// and an uncaught rejection would reach Express's own HTML error page instead.

import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@clawboo/connector-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clawboo/connector-catalog')>()),
  connectorsByCategory: () => [{ slug: 'playwright' }],
}))
vi.mock('../../lib/connectors/supervisor', () => ({
  getLiveConnector: () => {
    throw new Error('supervisor exploded')
  },
}))

const { agentScreenshotCapturePOST } = await import('../agents')

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
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
  return { res, status: () => code, body: () => payload }
}

describe('POST /api/agents/:agentId/screenshot/capture', () => {
  it('answers a failure as a JSON 500', async () => {
    const r = mockRes()
    await agentScreenshotCapturePOST(
      { params: { agentId: 'boo' }, query: {}, body: {} } as unknown as Request,
      r.res,
    )
    expect(r.status()).toBe(500)
    expect(r.body()).toEqual({ ok: false, error: expect.stringContaining('supervisor exploded') })
  })
})
