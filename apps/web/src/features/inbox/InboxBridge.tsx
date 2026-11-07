// Headless: keeps the person's inbox and badge up to date. Mounted once at the app
// root, whichever view is open and whether or not browser alerts are switched on.
//
// No polling, and no second notifier. `RunStatusBridge` holds the app's one live
// tail of the event log and wakes this through `alertSignal`, the same place the
// browser alerts wake from. This only reads; the alerts remain the one thing that
// raises a notification. An installed phone app has no service worker, so nothing
// reaches it while it is closed; the tail catches it up when it opens.
//
// A hidden tab shows no badge, so it reads nothing, however many tabs are open and
// however busy the board is. If it missed a wake, it reads once on its return.

import { useEffect } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { useAlertSignal } from '@/features/alerts/alertSignal'
import { ALERT_BATCH_MS, ALERT_RETRY_MS } from '@/features/alerts/NeedsYouAlerts'

import { useInboxStore, type InboxSnapshot } from './inboxStore'
import { createInboxWatcher } from './inboxWatcher'

/** Far more than this small read takes, even on a busy server. */
const INBOX_READ_DEADLINE_MS = 15_000

async function readInbox(signal: AbortSignal): Promise<boolean> {
  try {
    const res = await apiFetch('/api/board/inbox', { signal })
    if (!res.ok) return false
    useInboxStore.getState().apply((await res.json()) as InboxSnapshot)
    return true
  } catch {
    return false
  }
}

export function InboxBridge(): null {
  useEffect(() => {
    let missed = false
    const watcher = createInboxWatcher({
      read: (signal) => {
        if (document.hidden) {
          missed = true
          return Promise.resolve(true)
        }
        return readInbox(signal)
      },
      deadlineMs: INBOX_READ_DEADLINE_MS,
      batchMs: ALERT_BATCH_MS,
      retryMs: ALERT_RETRY_MS,
    })
    void watcher.readNow()
    const off = useAlertSignal.subscribe((s, prev) => {
      if (s.inbox !== prev.inbox) watcher.poke()
    })
    const onVisibility = (): void => {
      if (document.hidden || !missed) return
      missed = false
      void watcher.readNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      off()
      document.removeEventListener('visibilitychange', onVisibility)
      watcher.stop()
    }
  }, [])

  return null
}
