import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  IDLE_LAPSE_MS,
  RECONNECT_GRACE_MS,
  controllerOf,
  holdsControl,
  isPersonInControl,
  onControlChange,
  releaseControl,
  releaseControlByLink,
  resetControlForTests,
  sweepLapsed,
  takeControl,
  viewerDetached,
  viewerReattached,
} from '../control'

let now = 0
beforeEach(() => {
  now = 0
  resetControlForTests(() => now)
})
afterEach(() => resetControlForTests())

describe('control of an agent computer', () => {
  it('belongs to the agent until a person takes over, and the newest take over wins', () => {
    const changes: (string | null)[] = []
    onControlChange((c) => changes.push(c.controller?.viewerId ?? null))
    expect(isPersonInControl('a')).toBe(false)
    takeControl('a', 'v1', { kind: 'dashboard' })
    takeControl('a', 'v2', { kind: 'link', linkId: 'L' })
    expect(controllerOf('a')?.viewerId).toBe('v2')
    expect(holdsControl('a', 'v1')).toBe(false)
    expect(releaseControl('a', 'v1')).toBe(false)
    expect(releaseControl('a', 'v2')).toBe(true)
    expect(isPersonInControl('a')).toBe(false)
    expect(changes).toEqual(['v1', 'v2', null])
  })

  it('survives a dropped view for the reconnect grace, and no longer', () => {
    takeControl('a', 'v1', { kind: 'dashboard' })
    viewerDetached('a', 'v1')
    expect(holdsControl('a', 'v1')).toBe(false)
    now += RECONNECT_GRACE_MS - 1
    sweepLapsed()
    expect(viewerReattached('a', 'v1')).toBe(true)
    expect(holdsControl('a', 'v1')).toBe(true)
    viewerDetached('a', 'v1')
    now += RECONNECT_GRACE_MS
    sweepLapsed()
    expect(isPersonInControl('a')).toBe(false)
  })

  it('lets only a view that went away come back with its id', () => {
    takeControl('a', 'v1', { kind: 'dashboard' })
    expect(viewerReattached('a', 'v1')).toBe(false)
    viewerDetached('a', 'v1')
    expect(viewerReattached('a', 'v1')).toBe(true)
  })

  it('lapses back to the agent after a stretch with no input', () => {
    takeControl('a', 'v1', { kind: 'dashboard' })
    now += IDLE_LAPSE_MS - 1
    expect(holdsControl('a', 'v1')).toBe(true) // input resets the clock
    now += IDLE_LAPSE_MS - 1
    sweepLapsed()
    expect(isPersonInControl('a')).toBe(true)
    now += 1
    sweepLapsed()
    expect(isPersonInControl('a')).toBe(false)
  })

  it('hands back everything held through a link when the link ends', () => {
    takeControl('a', 'v1', { kind: 'link', linkId: 'L1' })
    takeControl('b', 'v2', { kind: 'link', linkId: 'L2' })
    takeControl('c', 'v3', { kind: 'dashboard' })
    releaseControlByLink('L1')
    expect(isPersonInControl('a')).toBe(false)
    expect(isPersonInControl('b')).toBe(true)
    expect(isPersonInControl('c')).toBe(true)
  })
})
