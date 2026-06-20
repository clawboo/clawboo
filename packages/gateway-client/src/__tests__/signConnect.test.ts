import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewayClient } from '../client'
import type { GatewayDeviceField } from '../types'

// The Node device-auth path: a non-browser caller injects `signConnect` (instead
// of the browser crypto.subtle path) and the client sets `params.device` from its
// return. Reuses the same MockWebSocket harness as client.test.ts.

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.OPEN
  sent: string[] = []

  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.OPEN) this.onopen?.()
    })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }))
  }

  simulateMessage(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

let wsInstance: MockWebSocket | null = null

beforeEach(() => {
  vi.useFakeTimers()
  wsInstance = null
  function TrackingWebSocket(url: string) {
    const instance = new MockWebSocket(url)
    wsInstance = instance
    return instance
  }
  Object.assign(TrackingWebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    prototype: MockWebSocket.prototype,
  })
  vi.stubGlobal('WebSocket', TrackingWebSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  wsInstance = null
})

const DEVICE: GatewayDeviceField = {
  id: 'device-1',
  publicKey: 'pub',
  signature: 'sig',
  signedAt: 1234,
}

function connectFrame(ws: MockWebSocket): Record<string, unknown> | undefined {
  return ws.sent
    .map((s) => JSON.parse(s) as Record<string, unknown>)
    .find((f) => f['method'] === 'connect')
}

describe('GatewayClient signConnect hook', () => {
  it('invokes the signer and sets params.device from its return (browser path skipped)', async () => {
    const signer = vi.fn(async (_params: Record<string, unknown>, _nonce: string | null) => ({
      device: DEVICE,
    }))
    const client = new GatewayClient()
    const connectPromise = client.connect('ws://localhost:18789', {
      clientName: 'clawboo-server',
      token: 'tok',
      disableDeviceAuth: true,
      signConnect: signer,
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(750)

    const ws = wsInstance!
    const req = connectFrame(ws)
    expect(req).toBeDefined()

    // Signer was called once with the assembled params + the (null) challenge nonce.
    expect(signer).toHaveBeenCalledTimes(1)
    const [paramsArg, nonceArg] = signer.mock.calls[0]!
    expect((paramsArg as Record<string, unknown>)['role']).toBe('operator')
    expect(
      ((paramsArg as Record<string, unknown>)['client'] as Record<string, unknown>)['id'],
    ).toBe('clawboo-server')
    expect(nonceArg).toBeNull()

    // The sent connect frame carries the signed device.
    const params = req!['params'] as Record<string, unknown>
    expect(params['device']).toEqual(DEVICE)
    // Token auth still present (signConnect does not replace it).
    expect((params['auth'] as Record<string, unknown>)['token']).toBe('tok')

    ws.simulateMessage({ type: 'res', id: req!['id'], ok: true, payload: { protocol: 4 } })
    await connectPromise
    client.disconnect()
  })

  it('proceeds without a device when the signer throws', async () => {
    const signer = vi.fn(async () => {
      throw new Error('sign failed')
    })
    const client = new GatewayClient()
    const connectPromise = client.connect('ws://localhost:18789', {
      disableDeviceAuth: true,
      signConnect: signer,
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(750)

    const ws = wsInstance!
    const req = connectFrame(ws)
    expect(req).toBeDefined()
    const params = req!['params'] as Record<string, unknown>
    expect(params['device']).toBeUndefined()

    // Connect still completes.
    ws.simulateMessage({ type: 'res', id: req!['id'], ok: true, payload: { protocol: 4 } })
    await connectPromise
    client.disconnect()
  })
})
