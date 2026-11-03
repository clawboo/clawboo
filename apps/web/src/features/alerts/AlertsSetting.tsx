// Settings, System: turn the browser alerts on or off, and see why they cannot
// be on when the browser or the desktop app decides that.

import { useEffect, useState } from 'react'

import { Button } from '@/features/shared/Button'
import { Switch } from '@/features/shared/Switch'
import { useToastStore } from '@/stores/toast'

import { alertAvailability, turnOnAlerts, useAlertPrefs } from './alertPrefs'
import { showTestAlert } from './NeedsYouAlerts'

const NOTE = 'mt-3 text-xs leading-relaxed text-muted-foreground'

export function AlertsSetting() {
  const choice = useAlertPrefs((s) => s.choice)
  const permission = useAlertPrefs((s) => s.permission)
  const setChoice = useAlertPrefs((s) => s.setChoice)
  const addToast = useToastStore((s) => s.addToast)
  const [asking, setAsking] = useState(false)

  // The browser's answer can change in its own settings while Clawboo is open.
  useEffect(() => {
    useAlertPrefs.getState().refreshPermission()
  }, [])

  const availability = alertAvailability(permission)

  if (availability === 'desktop') {
    return (
      <p data-testid="alerts-setting" className="text-compact leading-relaxed text-foreground">
        The Clawboo app tells you when a task needs you or an agent waits for your approval, as a
        notification from your computer. Browser alerts stay off here so you are not told twice.
      </p>
    )
  }
  if (availability === 'unsupported') {
    return (
      <p data-testid="alerts-setting" className="text-compact leading-relaxed text-foreground">
        This browser cannot show alerts. The board still lists everything under Needs you.
      </p>
    )
  }

  const on = choice === 'on' && availability === 'granted'

  const change = async (next: boolean): Promise<void> => {
    if (!next) {
      setChoice('off')
      return
    }
    setAsking(true)
    const answer = await turnOnAlerts()
    setAsking(false)
    if (answer === 'denied') {
      addToast({ message: 'Your browser blocked alerts for this page.', type: 'info' })
    }
  }

  return (
    <div data-testid="alerts-setting">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-compact font-medium text-foreground">
            Alert me when something needs you
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A browser notification when a task fails, stops responding, is blocked or does not pass
            its checks, and when an agent waits for your approval. Only while this tab is in the
            background, and only for what is new. Clicking it opens the task or the approval.
          </p>
        </div>
        <Switch
          checked={on}
          disabled={asking || availability === 'denied'}
          onChange={(next) => void change(next)}
          label="Alert me when something needs you"
        />
      </div>
      {availability === 'denied' ? (
        <p role="note" className={NOTE}>
          Your browser is blocking notifications from this page. Allow them in the site settings
          (the icon next to the address), then turn this on.
        </p>
      ) : null}
      {on ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (!showTestAlert()) {
                addToast({ message: 'The browser did not show the alert.', type: 'error' })
              }
            }}
          >
            Send a test alert
          </Button>
          <span className="text-xs text-muted-foreground">
            Nothing showed up? Check that your computer lets this browser show notifications.
          </span>
        </div>
      ) : null}
    </div>
  )
}
