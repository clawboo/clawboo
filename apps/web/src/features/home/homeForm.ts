// The form classes Home's dialogs share, matching the room and routine dialogs.

import type { GoalSummary } from '@clawboo/control-client'

export const FIELD_LABEL =
  'mb-1.5 block font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground'

export const FIELD_HINT = 'mt-1.5 text-xs leading-relaxed text-muted-foreground'

export const INPUT_CLASS =
  'h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-foreground ' +
  'outline-none transition placeholder:text-muted-foreground ' +
  'focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50'

export const TEXTAREA_CLASS =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] leading-relaxed text-foreground ' +
  'outline-none transition placeholder:text-muted-foreground ' +
  'focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50'

/** A dialog panel on the overlay tier. */
export const DIALOG_PANEL =
  'surface-overlay-tier flex max-h-[88vh] w-[480px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl'

/** A picker that fills its field, like the inputs beside it. */
export const FULL_WIDTH = { width: '100%' } as const

/** How a picker names a goal that is linked but not in its list (done, dropped or
 *  archived, or not loaded yet). */
export const INACTIVE_GOAL_LABEL = 'A goal that is not active'

/** A goal picker's options: No goal, the active goals, and the goal the record is
 *  linked to now when that one is not active, so the picker never shows "No goal" for
 *  a link it keeps. */
export function goalOptions(
  goals: readonly GoalSummary[],
  linked: string | null,
): { value: string; label: string }[] {
  const options = [
    { value: '', label: 'No goal' },
    ...goals.map((g) => ({ value: g.goal.id, label: g.goal.title })),
  ]
  if (linked && !goals.some((g) => g.goal.id === linked)) {
    options.push({ value: linked, label: INACTIVE_GOAL_LABEL })
  }
  return options
}
