import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { getTenantId } from '../tenant'

describe('getTenantId (the single tenant-resolution seam)', () => {
  it('returns null — the single implicit tenant (no-op in single-tenant)', () => {
    expect(getTenantId({} as Request)).toBeNull()
  })

  it('does NOT trust a raw header today (a spoofable header must not leak a tenant)', () => {
    const req = { headers: { 'x-tenant-id': 'spoofed' } } as unknown as Request
    expect(getTenantId(req)).toBeNull()
  })
})
