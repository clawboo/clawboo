// The live-socket → connection-store mirror. This is the wiring the issue asks
// for: the browser client already reports 'reconnecting' when its WebSocket
// drops, and until now nothing in the SPA subscribed, so the store kept saying
// "Connected" over a dead socket.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ConnectionStatus as SocketStatus } from '@clawboo/gateway-client'

import { makeFakeGatewayClient } from '@/__vitest__/fakeGatewayClient'
import { useConnectionStore, type ConnectionStatus } from '@/stores/connection'

import { useGatewayEvents } from '../useGatewayEvents'

beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})
afterEach(() => cleanup())

/**
 * Mount the hook against a fake client already installed in the store, as every
 * real connect flow does (setClient lands before the effect subscribes).
 *
 * `socketStatus` is explicit because `onStatus` REPLAYS it synchronously at
 * subscribe time — so it is itself a mirrored transition, not just setup.
 */
function mountWith(status: ConnectionStatus, socketStatus: SocketStatus = 'connected') {
  const fake = makeFakeGatewayClient(socketStatus)
  useConnectionStore.setState({ status, client: fake.client, gatewayUrl: 'ws://localhost:18789' })
  const view = renderHook(({ c }) => useGatewayEvents(c), { initialProps: { c: fake.client } })
  return { fake, ...view }
}

describe('useGatewayEvents — live socket status mirror', () => {
  it('mirrors a mid-session drop into the store', () => {
    const { fake } = mountWith('connected')

    act(() => fake.emit('reconnecting'))

    expect(useConnectionStore.getState().status).toBe('reconnecting')
  })

  it('mirrors the recovery back to connected', () => {
    const { fake } = mountWith('connected')
    act(() => fake.emit('reconnecting'))

    act(() => fake.emit('connected'))

    expect(useConnectionStore.getState().status).toBe('connected')
  })

  it('absorbs the repeated reconnecting emitted on every failed retry', () => {
    const { fake } = mountWith('connected')

    act(() => {
      fake.emit('reconnecting')
      fake.emit('reconnecting')
      fake.emit('reconnecting')
    })

    expect(useConnectionStore.getState().status).toBe('reconnecting')
  })

  it('subscribing replays the current status without stomping a matching store', () => {
    // The real `onStatus` fires synchronously at subscribe time; a client that is
    // already connected must not produce a spurious write.
    const { fake } = mountWith('connected')
    expect(fake.statusSubscribers()).toBe(1)
    expect(useConnectionStore.getState().status).toBe('connected')
  })
})

describe('useGatewayEvents — what the mirror refuses to do', () => {
  it('does not downgrade the app-level error to reconnecting', () => {
    // The socket is down at subscribe time, so the replay itself is the drop.
    const { fake } = mountWith('error', 'reconnecting')
    expect(useConnectionStore.getState().status).toBe('error')

    act(() => fake.emit('reconnecting'))

    // 'error' owns its own retry overlay; a spinning banner would replace a real
    // affordance with a dead one.
    expect(useConnectionStore.getState().status).toBe('error')
  })

  it('DOES let a recovered socket clear the error', () => {
    const { fake } = mountWith('error', 'reconnecting')

    act(() => fake.emit('connected'))

    // The complement of the rule above: a live socket is real evidence the error
    // is over, so it must not be sticky.
    expect(useConnectionStore.getState().status).toBe('connected')
  })

  it('ignores a socket-reported disconnect (owned by the explicit flows)', () => {
    const { fake } = mountWith('connected')

    act(() => fake.emit('disconnected'))

    expect(useConnectionStore.getState().status).toBe('connected')
  })

  it('ignores a SUPERSEDED client so its teardown cannot stomp the replacement', () => {
    // Every connect flow disconnects the previous client, and that teardown
    // emits. If the store has already moved on to a new client, the old one has
    // no business writing status.
    const { fake } = mountWith('connected')
    const replacement = makeFakeGatewayClient('connected')
    useConnectionStore.setState({ status: 'connected', client: replacement.client })

    act(() => fake.emit('reconnecting'))

    expect(useConnectionStore.getState().status).toBe('connected')
  })
})

describe('useGatewayEvents — subscription lifetime', () => {
  it('never subscribes in native mode (client is null)', () => {
    const fake = makeFakeGatewayClient('connected')
    useConnectionStore.setState({ status: 'connected', client: null })

    const { rerender } = renderHook(({ c }) => useGatewayEvents(c), {
      initialProps: { c: null as null | typeof fake.client },
    })
    expect(fake.statusSubscribers()).toBe(0)

    // ...and it arms/disarms as the client comes and goes.
    useConnectionStore.setState({ client: fake.client })
    rerender({ c: fake.client })
    expect(fake.statusSubscribers()).toBe(1)

    useConnectionStore.setState({ client: null })
    rerender({ c: null })
    expect(fake.statusSubscribers()).toBe(0)
  })

  it('unsubscribes on unmount, and later emits are inert', () => {
    const { fake, unmount } = mountWith('connected')

    unmount()

    expect(fake.statusSubscribers()).toBe(0)
    act(() => fake.emit('reconnecting'))
    expect(useConnectionStore.getState().status).toBe('connected')
  })
})
