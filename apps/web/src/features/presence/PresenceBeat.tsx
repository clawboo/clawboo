import { useEffect } from 'react'

import { apiFetch } from '@clawboo/control-client'

import { PRESENCE_BEAT_MS, createPresenceBeater, type PresenceBeatBody } from './presenceBeater'

/** Throttle for pointer movement, the one input event that fires continuously. */
const POINTER_MOVE_THROTTLE_MS = 1_000

function sendBeat(body: PresenceBeatBody): void {
  // keepalive, so the last beat as the page goes away still leaves.
  void apiFetch('/api/system/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => undefined)
}

function newTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * Tells the engine a person is at this tab (see presenceBeater.ts). Renders nothing.
 * Mounted once, at the app root, behind the access lock.
 */
export function PresenceBeat(): null {
  useEffect(() => {
    const beater = createPresenceBeater({
      tabId: newTabId(),
      send: sendBeat,
      isVisible: () => document.visibilityState === 'visible',
      hasFocus: () => document.hasFocus(),
    })
    beater.changed()

    let lastMoveAt = 0
    const onInput = (): void => beater.input()
    const onMove = (): void => {
      const t = Date.now()
      if (t - lastMoveAt < POINTER_MOVE_THROTTLE_MS) return
      lastMoveAt = t
      beater.input()
    }
    const onChange = (): void => beater.changed()
    const onLeave = (): void => beater.left()
    const inputEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const name of inputEvents) {
      window.addEventListener(name, onInput, { passive: true, capture: true })
    }
    window.addEventListener('pointermove', onMove, { passive: true, capture: true })
    document.addEventListener('visibilitychange', onChange)
    window.addEventListener('focus', onChange)
    window.addEventListener('blur', onChange)
    window.addEventListener('pagehide', onLeave)
    const timer = window.setInterval(() => beater.tick(), PRESENCE_BEAT_MS)

    return () => {
      window.clearInterval(timer)
      for (const name of inputEvents) window.removeEventListener(name, onInput, { capture: true })
      window.removeEventListener('pointermove', onMove, { capture: true })
      document.removeEventListener('visibilitychange', onChange)
      window.removeEventListener('focus', onChange)
      window.removeEventListener('blur', onChange)
      window.removeEventListener('pagehide', onLeave)
    }
  }, [])
  return null
}
