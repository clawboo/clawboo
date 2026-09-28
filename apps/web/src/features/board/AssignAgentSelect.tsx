// Hand a task to one member of its team. Picking a teammate binds the task to
// them and starts it straight away (POST /api/board/:id/assign). Used by the task
// drawer and by an unassigned card in the Needs you column.

import { useMemo, useState } from 'react'

import { useFleetStore } from '@/stores/fleet'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'

import { useTaskActions } from './useTaskActions'

const PLACEHOLDER = ''

export function AssignAgentSelect({
  taskId,
  teamId,
  onAssigned,
  label = 'Assign to…',
}: {
  taskId: string
  teamId: string
  /** Fires after a successful hand-off so the host can refresh. */
  onAssigned?: (agentId: string) => void
  label?: string
}) {
  const { assign } = useTaskActions()
  const agents = useFleetStore((s) => s.agents)
  // Filtered in a memo, not in the selector: a selector that builds a new array
  // on every call would never settle.
  const members = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const [saving, setSaving] = useState(false)

  if (members.length === 0) {
    return <span className="text-[12px] text-muted-foreground">No agents on this team</span>
  }

  async function handleChange(agentId: string) {
    if (!agentId) return
    const name = members.find((a) => a.id === agentId)?.name ?? 'the agent'
    setSaving(true)
    const ok = await assign(taskId, agentId, name)
    setSaving(false)
    if (ok) onAssigned?.(agentId)
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Select
        size="sm"
        aria-label="Assign to an agent"
        data-testid="assign-agent-select"
        value={PLACEHOLDER}
        onChange={(v) => void handleChange(v)}
        disabled={saving}
        menuWidth={200}
      >
        <option value={PLACEHOLDER} disabled>
          {label}
        </option>
        {members.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      {saving && <Spinner size={12} />}
    </span>
  )
}
