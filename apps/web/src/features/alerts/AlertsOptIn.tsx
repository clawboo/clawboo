// The board's one-time offer of browser alerts. It asks the browser for
// permission only when the person presses Turn on: a request on page load is
// one browsers mute, and one a person has no reason to accept yet.

import { useState } from 'react'
import { Bell } from 'lucide-react'

import { useToastStore } from '@/stores/toast'

import { alertAvailability, turnOnAlerts, useAlertPrefs } from './alertPrefs'

const ACTION =
  'shrink-0 cursor-pointer rounded font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50 disabled:hover:no-underline'

const EXPLAINER =
  'Clawboo can send a browser notification when a task fails, stops responding, is blocked or does not pass its checks, and when an agent waits for your approval. Only while this tab is in the background, and only for what is new.'

export function AlertsOptIn() {
  const choice = useAlertPrefs((s) => s.choice)
  const permission = useAlertPrefs((s) => s.permission)
  const setChoice = useAlertPrefs((s) => s.setChoice)
  const addToast = useToastStore((s) => s.addToast)
  const [asking, setAsking] = useState(false)

  const availability = alertAvailability(permission)
  // Asked once: any answer, here or in Settings, puts the offer away. A browser
  // that already blocks notifications has nothing to offer; Settings says why.
  if (choice !== null || (availability !== 'default' && availability !== 'granted')) return null

  const turnOn = async (): Promise<void> => {
    setAsking(true)
    const answer = await turnOnAlerts()
    setAsking(false)
    if (answer === 'granted') {
      addToast({
        message: 'Alerts are on. You can turn them off in Settings, under System.',
        type: 'success',
      })
    } else if (answer === 'denied') {
      addToast({
        message:
          'Your browser blocked alerts for this page. You can allow them from the site settings next to the address bar.',
        type: 'info',
        ttlMs: 8000,
      })
    }
    // Closing the browser's prompt without an answer leaves the offer here.
  }

  const notNow = (): void => {
    setChoice('off')
    addToast({
      message: 'No alerts. You can turn them on in Settings, under System.',
      type: 'info',
    })
  }

  return (
    <span
      role="group"
      aria-label="Browser alerts"
      data-testid="alerts-opt-in"
      className="inline-flex h-7 max-w-full items-center gap-2 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
    >
      <Bell size={12} strokeWidth={2} aria-hidden className="shrink-0" />
      <span className="truncate" title={EXPLAINER}>
        Get an alert when something needs you, even with this tab in the background
      </span>
      <button
        type="button"
        onClick={() => void turnOn()}
        disabled={asking}
        aria-describedby="alerts-opt-in-explainer"
        className={ACTION}
      >
        Turn on
      </button>
      <button type="button" onClick={notNow} disabled={asking} className={ACTION}>
        Not now
      </button>
      <span id="alerts-opt-in-explainer" className="sr-only">
        {EXPLAINER}
      </span>
    </span>
  )
}
