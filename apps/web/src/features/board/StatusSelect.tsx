// Inline status editor for the task-detail drawer. Replaces the static status
// text with a Select that writes through boardClient.updateStatus.
//
// It only offers the transitions the server will accept (statusOptions mirrors
// the state machine), updates optimistically for a snappy feel, and rolls back +
// toasts if the write is rejected (an illegal transition or a blocking
// verification gate both surface as `false`). Terminal tasks (done / cancelled)
// have no legal moves, so the control locks.
//
// Guard rail: the server clears the assignee on ANY transition to `todo` (the
// agent-release path — see updateStatus in @clawboo/db). So moving a task that an
// agent is actively working on back to "To do" would pull it out from under that
// agent mid-run. When that's the case we confirm first, rather than silently
// unassigning a live run.

import { useEffect, useState } from 'react'

import { boardClient } from '@/lib/boardClient'
import { confirm } from '@/stores/confirm'
import { useToastStore } from '@/stores/toast'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'

import { STATUS_LABEL, isTerminalStatus, statusLabel, statusOptions } from './boardStatus'

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
  const addToast = useToastStore((s) => s.addToast)
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
    // Moving to `todo` releases the task for re-claim and clears its assignee. If
    // an agent is on it, confirm before yanking the work out from under the run.
    if (next === 'todo' && assigneeAgentId) {
      const proceed = await confirm({
        title: 'Unassign the agent?',
        message:
          'Moving this task back to “To do” releases it for re-claim — the agent assigned to it will be unassigned.',
        confirmLabel: 'Move & unassign',
        tone: 'danger',
      })
      if (!proceed) return // leave the Select on its current value; nothing sent
    }
    const prev = value
    setValue(next) // optimistic
    setSaving(true)
    const ok = await boardClient.updateStatus(taskId, next)
    setSaving(false)
    if (ok) {
      addToast({ type: 'success', message: `Status updated to ${statusLabel(next)}` })
      onChange?.(next)
    } else {
      setValue(prev) // rollback
      addToast({ type: 'error', message: `Couldn’t move this task to ${statusLabel(next)}.` })
    }
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
