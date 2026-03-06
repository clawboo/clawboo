import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewayClient } from '../client'
import { GatewayResponseError } from '../errors'

// ─── MockWebSocket ────────────────────────────────────────────────────────────

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
    // Simulate async open
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.OPEN) {
        this.onopen?.()
      }
    })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED
    queueMicrotask(() => {
      this.onclose?.({ code: code ?? 1000, reason: reason ?? '' })
    })
  }

  // Test helper: simulate server sending a message
  simulateMessage(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  // Test helper: simulate close from server
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let wsInstance: MockWebSocket | null = null

beforeEach(() => {
  vi.useFakeTimers()
  wsInstance = null

  // Stub WebSocket globally with static constants
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

// Helper: complete the connect handshake
async function connectClient(
  client: GatewayClient,
  url = 'ws://localhost:18789',
): Promise<MockWebSocket> {
  const connectPromise = client.connect(url, { disableDeviceAuth: true })

  // Wait for microtask (ws.onopen)
  await vi.advanceTimersByTimeAsync(0)

  // Advance past the 750ms delay
  await vi.advanceTimersByTimeAsync(750)

  // Now the client should have sent a connect req — find it
  const ws = wsInstance!
  const connectReq = ws.sent
    .map((s) => JSON.parse(s) as Record<string, unknown>)
    .find((f) => f['method'] === 'connect')

  expect(connectReq).toBeDefined()

  // Simulate hello-ok response
  ws.simulateMessage({
    type: 'res',
    id: connectReq!['id'],
    ok: true,
    payload: { protocol: 3 },
  })

  await connectPromise
  return ws
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GatewayClient', () => {
  describe('call()', () => {
    it('sends a req frame with unique id and correct method', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)

      // Clear sent messages from connect handshake
      ws.sent.length = 0

      const callPromise = client.call('agents.list', { foo: 'bar' })

      const sentFrame = JSON.parse(ws.sent[0]) as Record<string, unknown>
      expect(sentFrame['type']).toBe('req')
      expect(sentFrame['method']).toBe('agents.list')
      expect(typeof sentFrame['id']).toBe('string')
      expect((sentFrame['id'] as string).length).toBeGreaterThan(0)
      expect(sentFrame['params']).toEqual({ foo: 'bar' })

      // Resolve the call
      ws.simulateMessage({
        type: 'res',
        id: sentFrame['id'],
        ok: true,
        payload: { agents: [] },
      })

      const result = await callPromise
      expect(result).toEqual({ agents: [] })

      client.disconnect()
    })

    it('resolves when matching res { ok: true } arrives', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)
      ws.sent.length = 0

      const callPromise = client.call('test.method')
      const frame = JSON.parse(ws.sent[0]) as Record<string, unknown>

      ws.simulateMessage({
        type: 'res',
        id: frame['id'],
        ok: true,
        payload: { data: 'success' },
      })

      await expect(callPromise).resolves.toEqual({ data: 'success' })
      client.disconnect()
    })

    it('rejects when matching res { ok: false } arrives', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)
      ws.sent.length = 0

      const callPromise = client.call('test.fail')
      const frame = JSON.parse(ws.sent[0]) as Record<string, unknown>

      ws.simulateMessage({
        type: 'res',
        id: frame['id'],
        ok: false,
        error: { message: 'something went wrong' },
      })

      await expect(callPromise).rejects.toThrow('something went wrong')
      client.disconnect()
    })

    it('rejects with GatewayResponseError when error has code', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)
      ws.sent.length = 0

      const callPromise = client.call('test.coded-error')
      const frame = JSON.parse(ws.sent[0]) as Record<string, unknown>

      ws.simulateMessage({
        type: 'res',
        id: frame['id'],
        ok: false,
        error: { code: 'NOT_FOUND', message: 'agent not found' },
      })

      await expect(callPromise).rejects.toBeInstanceOf(GatewayResponseError)
      await expect(callPromise).rejects.toThrow('agent not found')
      client.disconnect()
    })
  })

  describe('connection lifecycle', () => {
    it('pending calls are rejected when WebSocket closes', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)
      ws.sent.length = 0

      const callPromise = client.call('test.pending')

      // Close the connection
      ws.simulateClose(1006, 'connection lost')

      await expect(callPromise).rejects.toThrow()
      client.disconnect()
    })

    it('throws when connecting with empty URL', async () => {
      const client = new GatewayClient()
      await expect(client.connect('')).rejects.toThrow('Gateway URL is required')
    })

    it('throws when already connected', async () => {
      const client = new GatewayClient()
      await connectClient(client)
      await expect(
        client.connect('ws://localhost:18789', { disableDeviceAuth: true }),
      ).rejects.toThrow('already connected')
      client.disconnect()
    })
  })

  describe('onEvent', () => {
    it('handlers receive EventFrame objects', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)

      const events: Array<Record<string, unknown>> = []
      client.onEvent((e) => events.push(e as unknown as Record<string, unknown>))

      ws.simulateMessage({
        type: 'event',
        event: 'presence',
        payload: { agents: ['a1'] },
      })

      expect(events).toHaveLength(1)
      expect(events[0]['event']).toBe('presence')
      expect(events[0]['payload']).toEqual({ agents: ['a1'] })

      client.disconnect()
    })

    it('unsubscribe stops receiving events', async () => {
      const client = new GatewayClient()
      const ws = await connectClient(client)

      const events: unknown[] = []
      const unsub = client.onEvent((e) => events.push(e))

      ws.simulateMessage({ type: 'event', event: 'test1', payload: {} })
      expect(events).toHaveLength(1)

      unsub()

      ws.simulateMessage({ type: 'event', event: 'test2', payload: {} })
      expect(events).toHaveLength(1) // still 1

      client.disconnect()
    })
  })

  describe('onStatus', () => {
    it('fires immediately with current status', () => {
      const client = new GatewayClient()
      const statuses: string[] = []
      client.onStatus((s) => statuses.push(s))
      expect(statuses).toContain('disconnected')
    })
  })

  describe('call() throws when not connected', () => {
    it('rejects if called before connect', async () => {
      const client = new GatewayClient()
      await expect(client.call('test')).rejects.toThrow('not connected')
    })
  })
})
