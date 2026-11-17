// The goal a request sent from team chat counts toward. Shown above the composer
// only when the team has goals. It stays picked for this chat until changed, and
// reaches the server with each message; only a message that makes a request (a
// main task) uses it.

import { useEffect } from 'react'
import { Target } from 'lucide-react'

import { useTeamGoals } from '@/features/board/TaskGoal'
import { Select } from '@/features/shared/Select'

export function RequestGoalPicker({
  teamId,
  goalId,
  onChange,
}: {
  teamId: string
  goalId: string | null
  onChange: (goalId: string | null) => void
}) {
  const goals = useTeamGoals(teamId)
  // A picked goal that is no longer among the team's active goals (done, dropped, or
  // on another team) is cleared, so a request never carries a goal the picker does not
  // show. Only once the list is read: while it loads, nothing is known to be gone.
  const gone = goals !== null && goalId !== null && !goals.some((g) => g.id === goalId)
  useEffect(() => {
    if (gone) onChange(null)
  }, [gone, onChange])
  if (!goals || goals.length === 0) return null
  const shown = goals.some((g) => g.id === goalId) ? goalId : null
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-4 pb-1 text-xs text-muted-foreground"
      data-testid="request-goal-picker"
    >
      <Target size={13} strokeWidth={2} aria-hidden className="shrink-0" />
      <span className="shrink-0">New requests count toward</span>
      <Select
        size="sm"
        aria-label="Goal for new requests"
        value={shown ?? ''}
        onChange={(v) => onChange(v || null)}
        menuWidth={220}
        options={[
          { value: '', label: 'No goal' },
          ...goals.map((g) => ({ value: g.id, label: g.title })),
        ]}
      />
    </div>
  )
}
