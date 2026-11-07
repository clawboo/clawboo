// A team's "ask me before splitting work" switch: a plan, or a batch of hand-offs in one
// reply, waits in Needs you until a person accepts it. Off at first. Used by
// `TeamSettingsSheet`.

import { useEffect, useId, useState } from 'react'

import { Switch } from '@/features/shared/Switch'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { fetchTeamPlanApproval, saveTeamPlanApproval } from '@/lib/teamPlanApproval'
import { useToastStore } from '@/stores/toast'

export function TeamPlanApprovalSwitch({ teamId }: { teamId: string }) {
  const addToast = useToastStore((s) => s.addToast)
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(true)
  const hintId = useId()

  useEffect(() => {
    let live = true
    setBusy(true)
    void fetchTeamPlanApproval(teamId).then((value) => {
      if (!live) return
      setOn(value ?? false)
      setBusy(false)
    })
    return () => {
      live = false
    }
  }, [teamId])

  const change = (next: boolean): void => {
    setOn(next)
    setBusy(true)
    void saveTeamPlanApproval(teamId, next).then((saved) => {
      setBusy(false)
      if (saved === 'person_only') {
        setOn(!next)
        notePersonCheck(PERSON_CHECK_REFUSED)
        return
      }
      if (saved === null) {
        setOn(!next)
        addToast({ type: 'error', message: 'Couldn’t save that. Please try again.' })
        return
      }
      setOn(saved)
    })
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="m-0 text-sm text-foreground">Ask me before splitting work</p>
        <p id={hintId} className="m-0 mt-0.5 text-xs text-muted-foreground">
          A plan, or several tasks handed out in one reply, waits in Needs you until you accept it,
          change it or turn it down. Hand-offs an agent makes one at a time still go straight
          through.
        </p>
      </div>
      <Switch
        checked={on}
        onChange={change}
        disabled={busy}
        label="Ask me before splitting work"
        size="sm"
      />
    </div>
  )
}
