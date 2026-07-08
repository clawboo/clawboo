// serverAdapter — the shared OpenClaw operator-adapter construction. A null operator
// client (Gateway down) yields null so the caller degrades gracefully (serverDeliver
// failStart → the engine reflects; runTeamExchange drops the participant).

import { describe, expect, it } from 'vitest'

import { OpenClawAdapter, type OpenClawGatewayClient } from '@clawboo/adapter-openclaw'

import { buildOpenClawServerAdapter } from '../serverAdapter'

describe('buildOpenClawServerAdapter', () => {
  it('returns null when the operator client is unavailable (graceful degradation)', () => {
    expect(buildOpenClawServerAdapter(() => null)).toBeNull()
  })

  it('builds an OpenClawAdapter over the operator client when present', () => {
    const fakeClient = {} as unknown as OpenClawGatewayClient
    const adapter = buildOpenClawServerAdapter(() => fakeClient)
    expect(adapter).toBeInstanceOf(OpenClawAdapter)
    expect(adapter?.id).toBe('openclaw')
  })
})
