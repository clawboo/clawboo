// Whether stopping this machine stops the configured Gateway: loopback, this
// machine's own host name or one of its own addresses count; any other name reads
// as another machine.

import { describe, expect, it } from 'vitest'

import { isGatewayOnThisMachine } from '../openClawAgentSource'

const machine = {
  hostname: () => 'Studio.local',
  addresses: () => ['127.0.0.1', '192.168.1.20', 'fe80::1'],
}

describe('isGatewayOnThisMachine', () => {
  it('counts loopback, this host name with or without .local, and this machine’s addresses', () => {
    expect(isGatewayOnThisMachine('ws://127.0.0.1:18789', machine)).toBe(true)
    expect(isGatewayOnThisMachine('ws://localhost:18789', machine)).toBe(true)
    expect(isGatewayOnThisMachine('ws://[::1]:18789', machine)).toBe(true)
    expect(isGatewayOnThisMachine('ws://studio.local:18789', machine)).toBe(true)
    expect(isGatewayOnThisMachine('ws://STUDIO:18789', machine)).toBe(true)
    expect(isGatewayOnThisMachine('ws://192.168.1.20:18789', machine)).toBe(true)
    expect(isGatewayOnThisMachine('ws://[fe80::1]:18789', machine)).toBe(true)
  })

  it('reads any other name, a bad URL or none as not this machine', () => {
    expect(isGatewayOnThisMachine('wss://gateway.example.com', machine)).toBe(false)
    expect(isGatewayOnThisMachine('ws://192.168.1.21:18789', machine)).toBe(false)
    expect(isGatewayOnThisMachine('not a url', machine)).toBe(false)
    expect(isGatewayOnThisMachine(undefined, machine)).toBe(false)
  })
})
