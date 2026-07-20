// Lightweight probe of the clawboo-native runtime's connection state, for
// surfaces that would otherwise LIE about a keyless native agent (the chat
// header's green "Connected" dot reads the app-shell connection store, which is
// 'connected' in native mode even with zero provider keys — the reported
// "agents show connected but don't respond" symptom).
//
// Fail-SAFE by design: `null` (probe pending / failed) means "don't degrade the
// UI" — callers only show the keyless warning on a POSITIVE 'needs-auth' /
// 'not-installed' reading. Refreshes on window focus (the user typically fixes
// the key in another Settings surface and tabs back) + a slow poll.

import { useEffect, useState } from 'react'

import { fetchRuntimes, type ConnectionState } from '@clawboo/control-client'

const POLL_MS = 30_000

/** The native runtime's live connectionState, or null while unknown/unprobed.
 *  Inert (always null) when `enabled` is false. */
export function useNativeRuntimeState(enabled: boolean): ConnectionState | null {
  const [state, setState] = useState<ConnectionState | null>(null)

  useEffect(() => {
    if (!enabled) {
      setState(null)
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      const runtimes = await fetchRuntimes()
      if (cancelled || runtimes.length === 0) return // [] = probe failed → keep last
      const native = runtimes.find((r) => r.id === 'clawboo-native')
      setState(native?.connectionState ?? null)
    }
    void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      clearInterval(timer)
    }
  }, [enabled])

  return state
}
