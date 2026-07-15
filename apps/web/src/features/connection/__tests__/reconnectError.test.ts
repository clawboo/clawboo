// The banner's Reconnect must not dead-end the user on futile advice: an AUTH
// rejection is not a reachability failure, and retrying it re-sends the same
// token forever. Each kind has to map to a remedy that can actually work —
// `auth` is what swaps the banner's primary action to "Restart Gateway".

import { GatewayResponseError } from '@clawboo/gateway-client'
import { describe, expect, it } from 'vitest'

import { classifyReconnectError } from '../reconnectError'

describe('classifyReconnectError', () => {
  it('classifies a stale-token rejection as `auth` and asks for a RESTART, never "try again"', () => {
    // What the client actually rejects with: the Gateway closes the socket
    // pre-connect with code 1008 + this reason (verified against gateway.log).
    const info = classifyReconnectError(
      new Error(
        'Gateway closed (1008): unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)',
      ),
    )
    expect(info.kind).toBe('auth')
    expect(info.message).toMatch(/restart/i)
    expect(info.message).not.toMatch(/could not reach/i)
    expect(info.message).not.toMatch(/try again/i)
  })

  it('classifies NOT_PAIRED as its own kind (checked BEFORE the generic auth branch)', () => {
    const info = classifyReconnectError(
      new GatewayResponseError({
        code: 'NOT_PAIRED',
        message: 'pairing required: device is not approved yet',
      }),
    )
    expect(info.kind).toBe('not-paired')
    expect(info.message).toMatch(/needs approval/i)
  })

  it('classifies a genuinely unreachable Gateway as `unreachable` (retry is legitimate)', () => {
    const info = classifyReconnectError(new Error('connect ECONNREFUSED 127.0.0.1:18789'))
    expect(info.kind).toBe('unreachable')
    expect(info.message).toMatch(/could not reach the gateway/i)
  })
})
