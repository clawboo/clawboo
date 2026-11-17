// A task's goal on the Board: the chip on its card, the picker in its drawer, and
// the hook that reads a team's goals for both (and for the New task dialog, team
// chat's request picker and the goal filter). Goals are a team's own; a task can
// only take a goal on its own team.

import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'

import { setTaskGoal } from '@clawboo/control-client'

import { Select } from '@/features/shared/Select'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useGoalsStore, type GoalOption } from '@/stores/goals'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

const NO_GOAL = ''

/** A team's active goals, read on first use. Null while they are being read. */
export function useTeamGoals(
  teamId: string | null | undefined,
  enabled = true,
): GoalOption[] | null {
  const list = useGoalsStore((s) => (teamId ? s.byTeam[teamId] : undefined))
  useEffect(() => {
    if (teamId && enabled && list === undefined) void useGoalsStore.getState().load(teamId)
  }, [teamId, enabled, list])
  return teamId ? (list ?? null) : []
}

/** The goal a task counts toward, as a small chip on its card. Nothing while the
 *  team's goals are unread or the goal is no longer active. */
export function GoalChip({ goalId, teamId }: { goalId: string; teamId: string | null }) {
  const goals = useTeamGoals(teamId)
  const goal = goals?.find((g) => g.id === goalId)
  if (!goal) return null
  return (
    <span
      data-testid="task-goal-chip"
      title={`Goal: ${goal.title}`}
      className="inline-flex max-w-[160px] shrink-0 items-center gap-1 truncate rounded-md border border-border px-1.5 font-sans text-xs normal-case tracking-normal text-muted-foreground"
    >
      <Target size={11} strokeWidth={2} aria-hidden className="shrink-0" />
      <span className="truncate">{goal.title}</span>
      <span className="sr-only">{` (goal)`}</span>
    </span>
  )
}

/** The goal picker in a task's drawer: saved on change, and a link to the goal's
 *  page on Home. */
export function TaskGoalSelect({
  taskId,
  teamId,
  goalId,
  onChange,
  onSaved,
}: {
  taskId: string
  teamId: string
  goalId: string | null
  /** The goal shown: called at once, and again with the old one if the save fails. */
  onChange: (goalId: string | null) => void
  /** The server took the change. */
  onSaved?: () => void
}) {
  const goals = useTeamGoals(teamId)
  const [saving, setSaving] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  const current = goals?.find((g) => g.id === goalId) ?? null

  async function pick(value: string) {
    const next = value || null
    if (next === goalId) return
    const previous = goalId
    onChange(next)
    setSaving(true)
    try {
      await setTaskGoal(taskId, next)
      onSaved?.()
    } catch (err) {
      onChange(previous)
      const code = (err as { code?: unknown }).code
      if (code === 'person_only') notePersonCheck(PERSON_CHECK_REFUSED)
      else addToast({ type: 'error', message: 'Couldn’t change the goal. Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  if (goals !== null && goals.length === 0 && !goalId) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="task-goal-none">
        No goals on this team yet
      </span>
    )
  }

  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="task-goal">
      <Select
        size="sm"
        aria-label="Goal"
        data-testid="task-goal-select"
        value={goalId ?? NO_GOAL}
        disabled={saving || goals === null}
        onChange={(v) => void pick(v)}
        placeholder={goalId && !current ? 'A goal no longer active' : undefined}
        options={[
          { value: NO_GOAL, label: 'No goal' },
          ...(goals ?? []).map((g) => ({ value: g.id, label: g.title })),
        ]}
      />
      {current ? (
        <button
          type="button"
          onClick={() => useViewStore.getState().openHome(teamId, current.id)}
          className="shrink-0 cursor-pointer text-xs text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
        >
          Open
        </button>
      ) : null}
    </span>
  )
}
