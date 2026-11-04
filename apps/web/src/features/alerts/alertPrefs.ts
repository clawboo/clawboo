// The person's choice about browser alerts, and what this browser allows.
//
// The choice is per browser rather than per server, like the browser's own
// permission: `on` (asked for alerts), `off` (turned them off, or said Not now
// to the prompt), or null (not asked yet, so the board offers them once).

import { create } from 'zustand'

import { scopedLocalStorage } from '@/lib/clientStorage'

export type AlertChoice = 'on' | 'off'

/** What alerts can do here, in the order the checks run. */
export type AlertAvailability =
  /** Inside the Clawboo desktop app, which raises these natively. */
  | 'desktop'
  /** No Notification API (an old browser, or a page that is not secure). */
  | 'unsupported'
  /** The person blocked notifications for this site in the browser. */
  | 'denied'
  /** The browser has not been asked yet. */
  | 'default'
  | 'granted'

const STORAGE_KEY = 'clawboo.alerts.needsYou'

function readChoice(): AlertChoice | null {
  try {
    const v = scopedLocalStorage.getItem(STORAGE_KEY)
    return v === 'on' || v === 'off' ? v : null
  } catch {
    return null
  }
}

function writeChoice(choice: AlertChoice | null): void {
  try {
    if (choice) scopedLocalStorage.setItem(STORAGE_KEY, choice)
    else scopedLocalStorage.removeItem(STORAGE_KEY)
  } catch {
    // Private mode or blocked storage: the choice holds for this visit only.
  }
}

interface AlertPrefsState {
  choice: AlertChoice | null
  /** Mirrors `Notification.permission`; refreshed whenever it may have changed. */
  permission: NotificationPermission | null
  setChoice(choice: AlertChoice | null): void
  refreshPermission(): void
}

function currentPermission(): NotificationPermission | null {
  return typeof Notification === 'undefined' ? null : Notification.permission
}

export const useAlertPrefs = create<AlertPrefsState>((set) => ({
  choice: readChoice(),
  permission: currentPermission(),
  setChoice(choice) {
    writeChoice(choice)
    set({ choice })
  },
  refreshPermission() {
    set({ permission: currentPermission() })
  },
}))

/**
 * The Clawboo desktop app exposes `window.clawbooDesktop` to the dashboard it
 * hosts, and raises its own native alerts for the same events. A hosted
 * workspace opened in the app gets no bridge, and the app's watchers do not
 * cover it, so the browser alerts stay on there.
 */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = (window as { clawbooDesktop?: { isDesktop?: unknown } }).clawbooDesktop
  return bridge?.isDesktop === true
}

export function alertAvailability(permission: NotificationPermission | null): AlertAvailability {
  if (isDesktopShell()) return 'desktop'
  if (permission === null) return 'unsupported'
  return permission
}

/** True when alerts should be raised: asked for, allowed, and not the desktop app. */
export function alertsActive(
  choice: AlertChoice | null,
  permission: NotificationPermission | null,
): boolean {
  return choice === 'on' && alertAvailability(permission) === 'granted'
}

/**
 * Ask the browser for permission (only ever from a click: browsers ignore or
 * penalise a request made on page load) and record the choice when it is given.
 * Resolves to what the browser answered.
 */
export async function turnOnAlerts(): Promise<NotificationPermission | null> {
  const { setChoice, refreshPermission } = useAlertPrefs.getState()
  if (typeof Notification === 'undefined') return null
  let permission = Notification.permission
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission()
    } catch {
      permission = Notification.permission
    }
  }
  refreshPermission()
  if (permission === 'granted') setChoice('on')
  return permission
}
