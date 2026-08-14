// The mirror policy is the whole safety story for reflecting a live socket into
// the app's connection store, so it is pinned exhaustively here. Two of these
// cases are deliberate DEVIATIONS from the issue text and will look like bugs to
// a future reader — see the comments (and the module header) before "fixing" one.

import { describe, expect, it } from 'vitest'
import type { ConnectionStatus as SocketStatus } from '@clawboo/gateway-client'

import type { ConnectionStatus } from '@/stores/connection'
import { nextMirroredStatus } from '../socketStatusMirror'

const STORE_STATUSES: ConnectionStatus[] = [
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'error',
]

describe('nextMirroredStatus — the live-drop signal', () => {
  it('mirrors a drop into the store from every non-terminal status', () => {
    expect(nextMirroredStatus('reconnecting', 'connected')).toBe('reconnecting')
    expect(nextMirroredStatus('reconnecting', 'connecting')).toBe('reconnecting')
    expect(nextMirroredStatus('reconnecting', 'disconnected')).toBe('reconnecting')
  })

  it('does not rewrite an unchanged status (the client re-emits on every retry)', () => {
    // `updateStatus` has no dedupe and fires 'reconnecting' again on each failed
    // backoff attempt, so the mirror has to absorb the repeats.
    expect(nextMirroredStatus('reconnecting', 'reconnecting')).toBeNull()
    expect(nextMirroredStatus('connected', 'connected')).toBeNull()
  })
})

describe('nextMirroredStatus — recovery', () => {
  it('mirrors a recovered socket back to connected', () => {
    expect(nextMirroredStatus('connected', 'reconnecting')).toBe('connected')
    expect(nextMirroredStatus('connected', 'disconnected')).toBe('connected')
  })

  it('lets a recovered socket CLEAR the app-level error', () => {
    // The complement of the non-downgrade rule below: a live socket is real
    // evidence the error is over, so it must not be sticky.
    expect(nextMirroredStatus('connected', 'error')).toBe('connected')
  })
})

describe('nextMirroredStatus — what it refuses to write', () => {
  it('never downgrades the app-level error to a transient reconnecting', () => {
    // 'error' means a failed native hydrate / a rejected connect, whose retry UI
    // the manual flows own. Replacing it with a banner that just spins would
    // strand the user with no way forward.
    expect(nextMirroredStatus('reconnecting', 'error')).toBeNull()
  })

  it('ignores disconnected from ANY store status', () => {
    // DELIBERATE deviation from the issue's acceptance criteria. Every
    // 'disconnected' the client emits is downstream of an app-initiated
    // `disconnect()`, and every browser call site disconnects the OLD client
    // while it is still `store.client` and only then swaps in the new one — so
    // mirroring it would let a teardown stamp 'disconnected' over a connection
    // that just succeeded. See the module header.
    for (const current of STORE_STATUSES) {
      expect(nextMirroredStatus('disconnected', current)).toBeNull()
    }
  })

  it('ignores connecting from ANY store status', () => {
    // Only ever emitted inside `connect()`, before the client is in the store —
    // and the mount-time auto-connect spinner already owns that surface.
    for (const current of STORE_STATUSES) {
      expect(nextMirroredStatus('connecting', current)).toBeNull()
    }
  })
})

describe('nextMirroredStatus — totality', () => {
  it('returns either null or the socket status itself, never anything else', () => {
    const socketStatuses: SocketStatus[] = [
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
    ]
    for (const socket of socketStatuses) {
      for (const current of STORE_STATUSES) {
        const next = nextMirroredStatus(socket, current)
        expect(next === null || next === socket).toBe(true)
        // A no-op write is never emitted, so the store's `set` can stay naive.
        expect(next).not.toBe(current)
      }
    }
  })
})
