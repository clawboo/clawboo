// A task's priority, as a person sets it in the task drawer. Four named levels
// over the stored number (`priority.ts` in @clawboo/board-core); the board starts
// a higher one first when an agent has several tasks waiting.

import { useEffect, useState } from 'react'
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_VALUE,
  taskPriorityOf,
  type TaskPriority,
} from '@clawboo/board-core'

import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'
import { updateTaskPriority } from '@/lib/boardClient'
import { useToastStore } from '@/stores/toast'

export function PrioritySelect({
  taskId,
  priority,
  onChange,
}: {
  taskId: string
  /** The task's stored priority (any number; it reads as its nearest level). */
  priority: unknown
  /** Fires with the stored value once the change is saved. */
  onChange?: (priority: number) => void
}) {
  const level = taskPriorityOf(typeof priority === 'number' ? priority : null)
  const [value, setValue] = useState<TaskPriority>(level)
  const [saving, setSaving] = useState(false)
  const addToast = useToastStore((s) => s.addToast)
  // Follow the task when the drawer moves to another one or reloads it.
  useEffect(() => setValue(level), [taskId, level])

  async function handleChange(next: string) {
    const to = next as TaskPriority
    if (to === value) return
    const previous = value
    setValue(to)
    setSaving(true)
    const ok = await updateTaskPriority(taskId, TASK_PRIORITY_VALUE[to])
    setSaving(false)
    if (ok) {
      onChange?.(TASK_PRIORITY_VALUE[to])
      return
    }
    setValue(previous)
    addToast({ type: 'error', message: 'The priority could not be saved. Try again.' })
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Select
        size="sm"
        aria-label="Priority"
        data-testid="task-priority-select"
        value={value}
        onChange={(v) => void handleChange(v)}
        disabled={saving}
        menuWidth={140}
      >
        {TASK_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {TASK_PRIORITY_LABEL[p]}
          </option>
        ))}
      </Select>
      {saving && <Spinner size={12} />}
    </span>
  )
}
