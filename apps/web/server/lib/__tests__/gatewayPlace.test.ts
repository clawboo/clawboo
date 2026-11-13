// Where the configured Gateway runs: this machine by any of its names, another
// machine only by an address literal that is none of this machine's, and a name
// it cannot place stays unplaced. Whether anything listens there: refused is
// closed, anything else unknown.

import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { placeGateway, probeListening } from '../gatewayPlace'

const machine = {
  hostname: () => 'Studio.local',
  addresses: () => ['127.0.0.1', '192.168.1.20', 'fe80::1'],
}

describe('placeGateway', () => {
  it('places loopback, any-address binds and this machine’s names and addresses here', () => {
    for (const url of [
      'ws://127.0.0.1:18789',
      'ws://localhost:18789',
      'ws://[::1]:18789',
      'ws://[::ffff:127.0.0.1]:18789',
      'ws://0.0.0.0:18789',
      'ws://[::]:18789',
      'ws://gateway.localhost:18789',
      'ws://studio.local:18789',
      'ws://STUDIO:18789',
      'ws://192.168.1.20:18789',
      'ws://[fe80::1]:18789',
    ]) {
      expect(placeGateway(url, machine)?.place, url).toBe('here')
    }
    // An any-address bind is reached on loopback.
    expect(placeGateway('ws://0.0.0.0:18789', machine)).toEqual({
      place: 'here',
      host: '127.0.0.1',
      port: 18789,
    })
  })

  it('reads another machine only from an address literal that is none of this one’s', () => {
    expect(placeGateway('ws://192.168.1.21:18789', machine)?.place).toBe('elsewhere')
    expect(placeGateway('ws://[2001:db8::5]:18789', machine)?.place).toBe('elsewhere')
  })

  it('leaves a name it cannot place unplaced, not elsewhere', () => {
    for (const url of [
      'ws://studio.lan:18789',
      'ws://studio.home.arpa:18789',
      'ws://studio.tail1234.ts.net:18789',
      'wss://gateway.example.com',
    ]) {
      expect(placeGateway(url, machine)?.place, url).toBe('unplaced')
    }
    expect(placeGateway('wss://gateway.example.com', machine)?.port).toBe(443)
  })

  it('never throws when this machine’s names cannot be read', () => {
    const broken = {
      hostname: () => {
        throw new Error('no hostname here')
      },
      addresses: () => {
        throw new Error('no interfaces here')
      },
    }
    expect(placeGateway('ws://192.168.1.20:18789', broken)?.place).toBe('elsewhere')
    expect(placeGateway('ws://127.0.0.1:18789', broken)?.place).toBe('here')
    expect(placeGateway('not a url', broken)).toBeNull()
    expect(placeGateway(undefined, broken)).toBeNull()
  })
})

describe('probeListening', () => {
  it('says open when something listens, and closed when the connection is refused', async () => {
    const server = net.createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    expect(await probeListening('127.0.0.1', port)).toBe('open')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await probeListening('127.0.0.1', port)).toBe('closed')
  })
})
