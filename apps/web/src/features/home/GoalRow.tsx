// One goal in a list: its health dot, title, progress over its linked tasks (and
// how many of the done ones passed their check), target date, how the scope moved
// this week, drafts waiting, and "Update missing" when no update was published in
// its cadence. A goal whose update is missing fades its health.

import type { GoalSummary } from '@clawboo/control-client'

import { progressPercent, progressWords, scopeWords, targetDateWords } from './homeFormat'
import { HealthDot, HOME_ROW, ProgressBar } from './homeParts'

export function GoalRow({
  summary,
  now,
  onOpen,
  indent = false,
}: {
  summary: GoalSummary
  now: number
  onOpen: (goalId: string) => void
  /** A goal under another goal, drawn under its parent. */
  indent?: boolean
}) {
  const { goal, progress, updateMissing, draftCount } = summary
  const pct = progressPercent(progress)
  const scope = scopeWords(progress)
  const due = goal.targetDate !== null ? targetDateWords(goal.targetDate, now) : null
  return (
    <button
      type="button"
      data-testid="home-goal-row"
      data-goal-id={goal.id}
      onClick={() => onOpen(goal.id)}
      className={`${HOME_ROW} flex-col items-stretch gap-1.5 ${indent ? 'pl-8' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span style={{ opacity: updateMissing ? 0.45 : 1 }} className="inline-flex">
          <HealthDot health={goal.health} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {goal.title}
        </span>
        {draftCount > 0 ? (
          <span className="shrink-0 rounded-md border border-border px-1.5 text-micro font-medium text-foreground">
            {draftCount === 1 ? '1 draft' : `${draftCount} drafts`}
          </span>
        ) : null}
        {updateMissing ? (
          <span
            data-testid="goal-update-missing"
            className="board-reason shrink-0 text-micro font-semibold uppercase tracking-wide"
          >
            Update missing
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-3">
        <span className="w-24 shrink-0 sm:w-40">
          <ProgressBar
            percent={pct}
            faded={updateMissing}
            label={`${goal.title}: ${progressWords(progress)}`}
          />
        </span>
        <span className="min-w-0 truncate text-xs tabular-nums text-muted-foreground">
          {progressWords(progress)}
          {scope ? ` · ${scope}` : ''}
        </span>
        {due ? (
          <span
            className={[
              'ml-auto shrink-0 text-xs tabular-nums',
              due.overdue ? 'text-destructive' : 'text-muted-foreground',
            ].join(' ')}
          >
            {due.text}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** Goals in their order, each child under its parent. */
export function orderGoals(goals: GoalSummary[]): { summary: GoalSummary; child: boolean }[] {
  const ids = new Set(goals.map((g) => g.goal.id))
  const children = new Map<string, GoalSummary[]>()
  const top: GoalSummary[] = []
  for (const g of goals) {
    const parent = g.goal.parentGoalId
    if (parent && ids.has(parent)) {
      const list = children.get(parent) ?? []
      list.push(g)
      children.set(parent, list)
    } else top.push(g)
  }
  const out: { summary: GoalSummary; child: boolean }[] = []
  for (const g of top) {
    out.push({ summary: g, child: false })
    for (const c of children.get(g.goal.id) ?? []) out.push({ summary: c, child: true })
  }
  return out
}
