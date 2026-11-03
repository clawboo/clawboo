// Which way a Hermes run is driven: ACP unless this Hermes was just found
// without it, and the operator's override either way.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HERMES_ACP_RECHECK_MS,
  hermesTransport,
  markHermesAcpMissing,
  resetHermesTransport,
} from '../hermesTransport'

describe('hermesTransport', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env['CLAWBOO_HERMES_TRANSPORT']
    delete process.env['CLAWBOO_HERMES_TRANSPORT']
    resetHermesTransport()
  })
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAWBOO_HERMES_TRANSPORT']
    else process.env['CLAWBOO_HERMES_TRANSPORT'] = prev
    resetHermesTransport()
  })

  it('tries ACP by default', () => {
    expect(hermesTransport()).toBe('acp')
  })

  it('stays quiet for a while after a Hermes without ACP, then tries again', () => {
    markHermesAcpMissing('ACP dependencies not installed', 1_000)
    expect(hermesTransport(1_000 + HERMES_ACP_RECHECK_MS - 1)).toBe('quiet')
    expect(hermesTransport(1_000 + HERMES_ACP_RECHECK_MS)).toBe('acp')
  })

  it("follows the operator's override", () => {
    process.env['CLAWBOO_HERMES_TRANSPORT'] = 'quiet'
    expect(hermesTransport()).toBe('quiet')
    process.env['CLAWBOO_HERMES_TRANSPORT'] = 'ACP'
    markHermesAcpMissing('missing')
    expect(hermesTransport()).toBe('acp')
  })
})
