// The fault-injection runtime must be invisible unless an operator asks for it.
//
// This is the only thing standing between a testing harness and a normal
// install's runtime list, the UI, and `GET /api/runtimes`. It is one env read, so
// it is exactly the kind of guard that gets refactored away by accident.

import { afterEach, describe, expect, it } from 'vitest'

import { enabledRuntimeIds, adapterFactoryFor } from '../index'
import { MOCK_RUNTIME_ENV, mockRuntimeEnabled, NON_OPENCLAW_RUNTIME_IDS } from '../descriptor'

afterEach(() => {
  delete process.env[MOCK_RUNTIME_ENV]
})

describe('mock runtime gate', () => {
  it('is ABSENT from a normal install', () => {
    delete process.env[MOCK_RUNTIME_ENV]
    expect(mockRuntimeEnabled()).toBe(false)
    expect(enabledRuntimeIds()).not.toContain('clawboo-mock')
    // Also absent from the canonical id list, which is what the UI and the REST
    // surface enumerate.
    expect(NON_OPENCLAW_RUNTIME_IDS).not.toContain('clawboo-mock')
  })

  it('appears only for an EXACT opt-in, not any truthy value', () => {
    for (const v of ['0', 'true', 'yes', '']) {
      process.env[MOCK_RUNTIME_ENV] = v
      expect(enabledRuntimeIds()).not.toContain('clawboo-mock')
    }
    process.env[MOCK_RUNTIME_ENV] = '1'
    expect(enabledRuntimeIds()).toContain('clawboo-mock')
  })

  it('never displaces a real runtime when enabled', () => {
    process.env[MOCK_RUNTIME_ENV] = '1'
    const ids = enabledRuntimeIds()
    for (const real of NON_OPENCLAW_RUNTIME_IDS) expect(ids).toContain(real)
    expect(ids).toHaveLength(NON_OPENCLAW_RUNTIME_IDS.length + 1)
  })

  it('builds an adapter that needs no driver and no credentials', async () => {
    // The point of the harness: reproducible failures with nothing installed.
    const adapter = adapterFactoryFor('clawboo-mock')({} as never)
    expect(adapter.id).toBe('clawboo-mock')
    await expect(adapter.health()).resolves.toMatchObject({ ok: true })
  })
})
