// TeamAgentWakesToggle: whether this team's agents may wake each other without a person
// being asked once per job. Off, the first such wake on each job asks on a card in Needs
// you. The brakes hold either way. Used by `TeamSettingsSheet`.

import { useEffect, useState } from 'react'

import { Button } from '@/features/shared/Button'
import { Switch } from '@/features/shared/Switch'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { fetchTeamAgentWakes, saveTeamAgentWakes } from '@/lib/teamAgentWakes'
import { useToastStore } from '@/stores/toast'

export function TeamAgentWakesToggle({ teamId }: { teamId: string }) {
  const addToast = useToastStore((s) => s.addToast)
  const [always, setAlways] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    void fetchTeamAgentWakes(teamId).then((value) => {
      if (!live) return
      setAlways(value)
      setLoadFailed(value === null)
    })
    return () => {
      live = false
    }
  }, [teamId, attempt])

  const change = async (next: boolean): Promise<void> => {
    setSaving(true)
    const saved = await saveTeamAgentWakes(teamId, next)
    setSaving(false)
    if (saved === 'person_only') {
      notePersonCheck(PERSON_CHECK_REFUSED)
      return
    }
    if (saved === null) {
      addToast({ type: 'error', message: 'Couldn’t save that. Please try again.' })
      return
    }
    setAlways(saved)
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="m-0 text-xs text-muted-foreground">
          Let agents start each other with a comment without asking you first. Off, you are asked
          once per job. Pauses for too many wakes still apply.
        </p>
        {/* Off and disabled would read as this being off, which it may not be. */}
        {loadFailed ? (
          <p role="alert" className="m-0 mt-1 flex items-center gap-2 text-xs text-foreground">
            Couldn’t read this setting.
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLoadFailed(false)
                setAttempt((n) => n + 1)
              }}
            >
              Retry
            </Button>
          </p>
        ) : null}
      </div>
      <Switch
        checked={always === true}
        disabled={always === null || saving}
        label="Let agents wake each other without asking"
        onChange={(next) => void change(next)}
      />
    </div>
  )
}
