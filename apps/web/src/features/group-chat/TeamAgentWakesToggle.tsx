// TeamAgentWakesToggle: whether this team's agents may wake each other without a person
// being asked once per job. Off, the first such wake on each job asks on a card in Needs
// you. The brakes hold either way. Used by `TeamSettingsSheet`.

import { useEffect, useState } from 'react'

import { Switch } from '@/features/shared/Switch'
import { fetchTeamAgentWakes, saveTeamAgentWakes } from '@/lib/teamAgentWakes'
import { useToastStore } from '@/stores/toast'

export function TeamAgentWakesToggle({ teamId }: { teamId: string }) {
  const addToast = useToastStore((s) => s.addToast)
  const [always, setAlways] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    void fetchTeamAgentWakes(teamId).then((value) => {
      if (live) setAlways(value)
    })
    return () => {
      live = false
    }
  }, [teamId])

  const change = async (next: boolean): Promise<void> => {
    setSaving(true)
    const saved = await saveTeamAgentWakes(teamId, next)
    setSaving(false)
    if (saved === null) {
      addToast({ type: 'error', message: 'Couldn’t save that. Please try again.' })
      return
    }
    setAlways(saved)
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <p className="m-0 min-w-0 text-xs text-muted-foreground">
        Let agents start each other with a comment without asking you first. Off, you are asked once
        per job. Pauses for too many wakes still apply.
      </p>
      <Switch
        checked={always === true}
        disabled={always === null || saving}
        label="Let agents wake each other without asking"
        onChange={(next) => void change(next)}
      />
    </div>
  )
}
