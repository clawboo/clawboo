import net from 'net'

import { describe, expect, it } from 'vitest'

import { startListening } from './startListening'

describe('startListening', () => {
  it('rejects when the server errors before it is listening', async () => {
    const server = net.createServer()
    const refused = Object.assign(
      new Error('listen EAFNOSUPPORT: address family not supported ::1'),
      {
        code: 'EAFNOSUPPORT',
      },
    )
    // What Node does on a machine with no IPv6 loopback: an 'error' event on the
    // next tick, and the listen callback never runs.
    server.listen = (() => {
      process.nextTick(() => server.emit('error', refused))
      return server
    }) as unknown as typeof server.listen
    await expect(startListening(server, '::1')).rejects.toBe(refused)
  })

  it('resolves once listening, and leaves no error listener behind', async () => {
    const server = net.createServer()
    const before = server.listenerCount('error')
    await startListening(server, '127.0.0.1')
    try {
      expect(server.listening).toBe(true)
      expect(server.listenerCount('error')).toBe(before)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
