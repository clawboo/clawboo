// A task's goal on the Board: the chip on its card, the picker in its drawer, and
// the hook that reads a team's goals for both (and for the New task dialog, team
// chat's request picker and the goal filter). Goals are a team's own; a task can
// only take a goal on its own team.

import { useEffect, useState } from 'react'
import { Target } from 'lucide-react'

import { setTaskGoal, type GoalLinkVia } from '@clawboo/control-client'

import { Select } from '@/features/shared/Select'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useGoalsStore, type GoalOption } from '@/stores/goals'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

const NO_GOAL = ''
/** The picker's value for a goal the task inherits rather than names. */
const INHERITED = 'inherited'

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
/** How a task reaches its goal, in words, for one it inherits. */
export const GOAL_LINK_WORDS: Record<GoalLinkVia, string | null> = {
  own: null,
  request: 'through its request',
  parent: 'through its parent task',
}

/** The goal a task counts toward, as a chip: its own goal, or one it inherits from
 *  its request or a parent task (drawn with a dashed edge, and said in words). */
export function GoalChip({
  goalId,
  teamId,
  linkedVia = null,
}: {
  goalId: string
  teamId: string | null
  /** How the task reaches the goal; `request` or `parent` mark an inherited one. */
  linkedVia?: GoalLinkVia | null
}) {
  const goals = useTeamGoals(teamId)
  const goal = goals?.find((g) => g.id === goalId)
  if (!goal) return null
  const via = linkedVia ? GOAL_LINK_WORDS[linkedVia] : null
  const words = via ? `Goal: ${goal.title}, ${via}` : `Goal: ${goal.title}`
  return (
    <span
      data-testid="task-goal-chip"
      data-linked-via={linkedVia ?? undefined}
      title={words}
      className={[
        'inline-flex max-w-[160px] shrink-0 items-center gap-1 truncate rounded-md border border-border px-1.5 font-sans text-xs normal-case tracking-normal text-muted-foreground',
        via ? 'border-dashed' : '',
      ].join(' ')}
    >
      <Target size={11} strokeWidth={2} aria-hidden className="shrink-0" />
      <span className="truncate">{goal.title}</span>
      <span className="sr-only">{via ? ` (goal, ${via})` : ' (goal)'}</span>
    </span>
  )
}

/** What a task's goal fields say: the goal it names, the goal it counts toward, and
 *  how it reaches that one. */
export interface TaskGoalLink {
  goalId: string | null
  effectiveGoalId: string | null
  goalLinkedVia: GoalLinkVia | null
}

/** The goal picker in a task's drawer: saved on change, and a link to the goal's
 *  page on Home. */
export function TaskGoalSelect({
  taskId,
  teamId,
  goalId,
  inherited = null,
  onChange,
  onSaved,
}: {
  taskId: string
  teamId: string
  /** The goal the task itself names. */
  goalId: string | null
  /** The goal it counts toward through its request or a parent, when it names none. */
  inherited?: { goalId: string; via: GoalLinkVia } | null
  /** The goal shown: called at once, and again with the old link (an inherited goal
   *  included) if the save fails. */
  onChange: (link: TaskGoalLink) => void
  /** The server took the change. */
  onSaved?: () => void
}) {
  const goals = useTeamGoals(teamId)
  const [saving, setSaving] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  const own = goals?.find((g) => g.id === goalId) ?? null
  const fromAbove =
    !goalId && inherited ? (goals?.find((g) => g.id === inherited.goalId) ?? null) : null
  const via = inherited ? GOAL_LINK_WORDS[inherited.via] : null
  const current = own ?? fromAbove

  async function pick(value: string) {
    // The inherited choice is what the task has already.
    if (value === INHERITED) return
    const next = value || null
    // "No goal" on a task that inherits one takes it off that goal too.
    if (next === goalId && !(next === null && fromAbove)) return
    const previous: TaskGoalLink = goalId
      ? { goalId, effectiveGoalId: goalId, goalLinkedVia: 'own' }
      : {
          goalId: null,
          effectiveGoalId: inherited?.goalId ?? null,
          goalLinkedVia: inherited?.via ?? null,
        }
    // A goal of its own is what it counts toward; none takes it off an inherited one too.
    onChange({ goalId: next, effectiveGoalId: next, goalLinkedVia: next ? 'own' : null })
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

  if (goals !== null && goals.length === 0 && !goalId && !fromAbove) {
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
        value={goalId ?? (fromAbove ? INHERITED : NO_GOAL)}
        disabled={saving || goals === null}
        onChange={(v) => void pick(v)}
        placeholder={goalId && !own ? 'A goal no longer active' : undefined}
        options={[
          ...(fromAbove && via ? [{ value: INHERITED, label: `${fromAbove.title}, ${via}` }] : []),
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
