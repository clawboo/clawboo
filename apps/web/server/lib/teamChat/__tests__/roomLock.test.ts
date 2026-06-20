import { afterEach, describe, expect, it } from 'vitest'

import { isRoomBusy, releaseRoom, resetRoomLocks, tryAcquireRoom } from '../roomLock'

afterEach(() => resetRoomLocks())

describe('roomLock (per-room re-entrancy guard)', () => {
  it('refuses a second acquire until released (refuse-overlap, not queue)', () => {
    expect(tryAcquireRoom('r1')).toBe(true)
    expect(tryAcquireRoom('r1')).toBe(false) // an overlapping exchange is refused
    expect(isRoomBusy('r1')).toBe(true)
    releaseRoom('r1')
    expect(isRoomBusy('r1')).toBe(false)
    expect(tryAcquireRoom('r1')).toBe(true) // free again after release
  })

  it('claims are per-room (one busy room does not block another)', () => {
    expect(tryAcquireRoom('r1')).toBe(true)
    expect(tryAcquireRoom('r2')).toBe(true)
  })
})
