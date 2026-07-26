// Inline status editor for the task-detail drawer. Replaces the static status
// text with a Select that writes through the shared `useStatusMutation` (the same
// path the board's drag-and-drop uses, so the two stay in lock-step).
//
// It only offers the transitions the server will accept (statusOptions mirrors
// the state machine), updates optimistically for a snappy feel, and rolls back +
// toasts if the write is rejected. Terminal tasks (done / cancelled) have no legal
// moves, so the control locks. The agent-release (`→ todo`) confirm gate lives in
// `useStatusMutation`.

import { useEffect, useState } from 'react'

import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'

import { STATUS_LABEL, isTerminalStatus, statusLabel, statusOptions } from './boardStatus'
import { useStatusMutation } from './useStatusMutation'

export interface StatusSelectProps {
  taskId: string
  status: string
  /** The agent currently assigned to the task, if any. Present ⇒ moving the task
   *  to `todo` would unassign a live run, so we confirm before doing so. */
  assigneeAgentId?: string | null
  /** Notifies the parent of a committed change so it can keep its copy in sync. */
  onChange?: (next: string) => void
}

export function StatusSelect({ taskId, status, assigneeAgentId, onChange }: StatusSelectProps) {
  const mutate = useStatusMutation()
  const [value, setValue] = useState(status)
  const [saving, setSaving] = useState(false)

  // A fresh task load (or an agent moving the card underneath us) reseeds the
  // control — but never mid-write, so an in-flight optimistic value isn't clobbered.
  useEffect(() => {
    if (!saving) setValue(status)
  }, [status, saving])

  const options = statusOptions(value)

  // Off-list status (nothing legal to offer) → read-only display, matching the
  // board's catch-all "Other" handling rather than a broken, empty dropdown.
  if (options.length === 0) {
    return (
      <span className="font-data text-[12.5px] text-foreground" data-testid="task-status-readonly">
        {statusLabel(value)}
      </span>
    )
  }

  const locked = saving || isTerminalStatus(value)

  async function handleChange(next: string) {
    if (next === value) return
    const prev = value
    // The confirm gate, illegal-transition guard, PATCH, and toasts all live in the
    // shared hook; StatusSelect only owns its own optimistic value + spinner. `saving`
    // flips on inside applyOptimistic (after the confirm gate passes and the write
    // begins), so the spinner/disabled-select never show during the confirm wait.
    const ok = await mutate({
      taskId,
      from: value,
      to: next,
      assigneeAgentId,
      applyOptimistic: () => {
        setValue(next)
        setSaving(true)
      },
      rollback: () => setValue(prev),
    })
    setSaving(false)
    if (ok) onChange?.(next)
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Select
        size="sm"
        aria-label="Task status"
        data-testid="task-status-select"
        value={value}
        onChange={handleChange}
        disabled={locked}
        menuWidth={140}
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </Select>
      {saving && <Spinner size={12} />}
    </span>
  )
}
