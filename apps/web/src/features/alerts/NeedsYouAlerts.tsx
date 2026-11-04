// Headless: raises a browser notification when something new needs the person
// while this tab is in the background. Mounted once at the app root.
//
// No polling. The app's one live tail of the event log (`RunStatusBridge`)
// notes each event after which what needs a person may have changed (a run
// ended, a task moved, an approval opened), and the Gateway socket delivers
// shell approvals to the approvals store. Either one, while the tab is in the
// background, schedules ONE read of the board and the approval queue a moment
// later, so a burst of events becomes one read and one alert. A read that
// fails is tried again a few times, so a quiet board still gets its alert.
//
// While the tab is in front nothing is read. On the way to the background the
// watcher notes the time and reads once to take what is waiting as seen: the
// person was looking at it, so only what begins waiting after that is announced.

import { useEffect } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { fetchBoardResult } from '@/lib/boardClient'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useViewStore } from '@/stores/view'

import { alertsActive, useAlertPrefs } from './alertPrefs'
import { useAlertSignal } from './alertSignal'
import {
  createAlertWatcher,
  type AlertAgent,
  type AlertApprovalInput,
  type AlertNotice,
  type AlertTarget,
} from './alertRules'

/** How long after the first event of a burst the read waits for the rest. */
export const ALERT_BATCH_MS = 1000

/** When a read fails, read again after these waits, then wait for the next
 *  event. A quiet board would otherwise never get the alert. */
export const ALERT_RETRY_MS: readonly number[] = [5_000, 20_000, 60_000]

/** Behind another tab or window, or in a window that does not have focus. */
function inBackground(): boolean {
  return document.hidden || !document.hasFocus()
}

/** Shell approvals the Gateway socket delivered, which the server may not have
 *  mirrored yet. The same id from both sources is announced once. */
function localExecApprovals(): AlertApprovalInput[] {
  return Array.from(useApprovalsStore.getState().pendingApprovals.values(), (a) => ({
    id: a.id,
    toolName: 'exec',
    agentId: a.agentId,
    kind: 'exec',
    createdAt: a.createdAtMs,
    expiresAt: a.expiresAtMs,
  }))
}

async function readApprovals(): Promise<{ rows: AlertApprovalInput[]; complete: boolean }> {
  try {
    const res = await apiFetch('/api/tools/approvals?status=pending')
    if (res.ok) {
      const body = (await res.json()) as {
        approvals?: Array<{
          id: string
          toolName: string
          agentId: string | null
          kind?: string | null
          createdAt?: number | null
          expiresAt?: number | null
        }>
      }
      const rows = (body.approvals ?? []).map((a): AlertApprovalInput => ({
        id: a.id,
        toolName: a.toolName,
        agentId: a.agentId ?? null,
        kind: a.kind ?? null,
        createdAt: a.createdAt ?? null,
        expiresAt: a.expiresAt ?? null,
      }))
      return { rows: [...rows, ...localExecApprovals()], complete: true }
    }
  } catch {
    // Read below as incomplete.
  }
  // The queue could not be read; what the Gateway delivered can still be told.
  return { rows: localExecApprovals(), complete: false }
}

function agentOf(id: string | null): AlertAgent | null {
  if (!id) return null
  const agent = useFleetStore.getState().agents.find((a) => a.id === id)
  return agent ? { name: agent.name, teamId: agent.teamId } : null
}

/** Take the person to what the alert is about. */
export function openAlertTarget(target: AlertTarget): void {
  useSettingsModalStore.getState().close()
  const view = useViewStore.getState()
  if (target.kind === 'task') view.openBoardTask(target.taskId, target.teamId)
  else view.openBoardNeedsYou(target.teamId)
}

export function showAlert(notice: AlertNotice): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    const n = new Notification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: '/favicon-32.png',
    })
    n.onclick = () => {
      window.focus()
      n.close()
      openAlertTarget(notice.target)
    }
  } catch {
    // Some browsers (Chrome on Android) only raise notifications through a
    // service worker and throw here; the board still shows everything.
  }
}

/** A sample alert, so the person can see one and check that the browser and
 *  the computer let it through. A click brings the tab back. */
export function showTestAlert(): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  try {
    const n = new Notification('Alerts are working', {
      body: 'This is how Clawboo tells you that something needs you.',
      tag: 'clawboo-test-alert',
      icon: '/favicon-32.png',
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
    return true
  } catch {
    return false
  }
}

export function NeedsYouAlerts({
  batchMs = ALERT_BATCH_MS,
  retryMs = ALERT_RETRY_MS,
}: {
  batchMs?: number
  retryMs?: readonly number[]
} = {}): null {
  const choice = useAlertPrefs((s) => s.choice)
  const permission = useAlertPrefs((s) => s.permission)
  const active = alertsActive(choice, permission)

  // The person can allow or block notifications from the browser's site
  // settings while the page is open.
  useEffect(() => {
    const refresh = (): void => useAlertPrefs.getState().refreshPermission()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    let status: PermissionStatus | null = null
    let disposed = false
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        if (disposed) return
        status = s
        status.addEventListener('change', refresh)
      })
      .catch(() => {
        // No Permissions API here; focus and visibility still refresh it.
      })
    return () => {
      disposed = true
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      status?.removeEventListener('change', refresh)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let background = false
    let timer: number | null = null
    let retryTimer: number | null = null
    let retries = 0
    const cancelTimer = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }
    const cancelRetry = (): void => {
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      retryTimer = null
      retries = 0
    }
    // A read that came back incomplete is tried again a few times, further
    // apart each time; a complete one ends the run of retries.
    const onRead = (complete: boolean): void => {
      if (complete) {
        cancelRetry()
        return
      }
      if (!background || retryTimer !== null || retries >= retryMs.length) return
      const wait = retryMs[retries]!
      retries += 1
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        if (background) void watcher.check()
      }, wait)
    }

    const watcher = createAlertWatcher({
      readTasks: async () => {
        const res = await fetchBoardResult()
        return res.ok ? res.tasks : null
      },
      readApprovals,
      agentOf,
      notify: showAlert,
      onRead,
    })
    // Throttled, not debounced: a run that keeps moving tasks must not hold
    // the read off for as long as it keeps going.
    const schedule = (): void => {
      if (!background || timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        void watcher.check()
      }, batchMs)
    }
    const sync = (): void => {
      const next = inBackground()
      if (next === background) return
      background = next
      if (next) {
        // From this moment only what begins waiting is news.
        void watcher.prime(Date.now())
      } else {
        cancelTimer()
        cancelRetry()
        watcher.reset()
      }
    }
    // `document.hasFocus()` settles only after the blur event has run.
    const syncSoon = (): void => void window.setTimeout(sync, 0)

    sync()
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    window.addEventListener('blur', syncSoon)
    const offSignal = useAlertSignal.subscribe((s, prev) => {
      if (s.seq !== prev.seq) schedule()
    })
    const offExec = useApprovalsStore.subscribe((s, prev) => {
      if (s.pendingApprovals !== prev.pendingApprovals) schedule()
    })

    return () => {
      cancelTimer()
      cancelRetry()
      watcher.reset()
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', syncSoon)
      offSignal()
      offExec()
    }
  }, [active, batchMs, retryMs])

  return null
}
