// A minimal stand-in for a live `GatewayClient`, for tests that need to drive
// socket-status transitions (the `useGatewayEvents` mirror, the live-reconnect
// banner) without a real WebSocket.
//
// `useGatewayEvents` touches exactly two client methods — `onEvent` and
// `onStatus` — so that is all this implements, plus a `disconnect` spy for the
// paths that tear a client down.
//
// FIDELITY NOTE: the real `onStatus` (gateway-client `client.ts:102-106`) invokes
// the handler SYNCHRONOUSLY at subscribe time, replaying the current status. This
// fake does the same. Without that replay the mirror's "unchanged → no write"
// branch is never exercised and a regression there would slip through.

import { vi } from 'vitest'
import type { ConnectionStatus, GatewayClient } from '@clawboo/gateway-client'

export interface FakeGatewayClient {
  /** Pass this where a real `GatewayClient` is expected. */
  client: GatewayClient
  /** Drive a socket transition, the way `updateStatus` fans out. */
  emit: (next: ConnectionStatus) => void
  /** Live `onStatus` subscriber count — 0 proves cleanup ran. */
  statusSubscribers: () => number
  /** Live `onEvent` subscriber count. */
  eventSubscribers: () => number
  disconnect: ReturnType<typeof vi.fn>
}

export function makeFakeGatewayClient(initial: ConnectionStatus = 'connected'): FakeGatewayClient {
  const statusHandlers = new Set<(s: ConnectionStatus) => void>()
  const eventHandlers = new Set<(frame: unknown) => void>()
  let current = initial
  const disconnect = vi.fn()

  const client = {
    get status() {
      return current
    },
    onStatus(handler: (s: ConnectionStatus) => void) {
      statusHandlers.add(handler)
      handler(current) // replay, mirroring the real client
      return () => statusHandlers.delete(handler)
    },
    onEvent(handler: (frame: unknown) => void) {
      eventHandlers.add(handler)
      return () => eventHandlers.delete(handler)
    },
    disconnect,
  } as unknown as GatewayClient

  return {
    client,
    emit: (next) => {
      current = next
      for (const h of [...statusHandlers]) h(next)
    },
    statusSubscribers: () => statusHandlers.size,
    eventSubscribers: () => eventHandlers.size,
    disconnect,
  }
}
