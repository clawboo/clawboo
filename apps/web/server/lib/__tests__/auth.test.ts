import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

import { attachIdentity, getUserId } from '../auth'

describe('attachIdentity (the no-op identity middleware seam)', () => {
  it('populates req.tenantId / req.userId (both null today) and calls next() once with no error', () => {
    const req = {} as Request
    const res = {} as Response
    const next = vi.fn()

    attachIdentity(req, res, next)

    expect(req.tenantId).toBeNull()
    expect(req.userId).toBeNull()
    expect(next).toHaveBeenCalledTimes(1)
    // next() with no argument = continue the chain (never next(err) — this never blocks).
    expect(next).toHaveBeenCalledWith()
  })

  it('is a transparent pass-through — never touches the response', () => {
    const req = {} as Request
    const res = {
      status: vi.fn(),
      json: vi.fn(),
      send: vi.fn(),
      end: vi.fn(),
    } as unknown as Response
    const next = vi.fn()

    attachIdentity(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(res.send).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it('getUserId returns null — the single implicit user', () => {
    expect(getUserId({} as Request)).toBeNull()
  })
})
