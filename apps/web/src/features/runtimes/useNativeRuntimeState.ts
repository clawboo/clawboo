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

import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchRuntimes, type ConnectionState } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

const POLL_MS = 30_000

/** The native runtime's live connectionState, or null while unknown/unprobed.
 *  Inert (always null) when `enabled` is false. */
export function useNativeRuntimeState(enabled: boolean): ConnectionState | null {
  const [state, setState] = useState<ConnectionState | null>(null)
  // `load` is hoisted out of the effect so the poller can share it, so the
  // effect-local `cancelled` flag becomes a generation counter: a response only
  // writes while it is still the newest, which covers unmount and the hook being
  // disabled mid-probe.
  const generationRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current
    const runtimes = await fetchRuntimes()
    if (generationRef.current !== generation || runtimes.length === 0) return // [] = probe failed → keep last
    const native = runtimes.find((r) => r.id === 'clawboo-native')
    setState(native?.connectionState ?? null)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setState(null)
      return
    }
    void load()
    return () => {
      generationRef.current += 1 // invalidate whatever is still in flight
    }
  }, [enabled, load])

  // `refreshOnFocus` keeps the original behaviour: the user fixes a key in
  // another app and tabs back, which regains window focus WITHOUT ever firing
  // `visibilitychange` (the tab stayed the selected one all along).
  useVisiblePolling(() => void load(), POLL_MS, { enabled, refreshOnFocus: true })

  return state
}
