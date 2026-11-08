import type { Server } from 'net'

/**
 * Starts `server` on a free port of `host`. Rejects when the server errors
 * before it is listening (EAFNOSUPPORT for `::1` on a machine with no IPv6
 * loopback, say), so a test can skip or fail straight away. A bare
 * `server.listen(0, host, resolve)` never settles then: the test waits out its
 * timeout, and vitest also reports the error as uncaught.
 */
export function startListening(server: Server, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
