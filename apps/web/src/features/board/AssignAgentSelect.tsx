// Hand a task to one member of its team, or take it yourself. Picking a teammate
// binds the task to them and starts it straight away (POST /api/board/:id/assign);
// picking "You", or the person who asked for it, makes it that person's task, and
// nothing starts it. There is no member list, so those are the people it can name.
// Used by the task drawer.

import { useMemo, useState } from 'react'

import { useFleetStore } from '@/stores/fleet'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'

import { useTaskActions } from './useTaskActions'

const PLACEHOLDER = ''
const ME = 'person:me'
const ASKER = 'person:asker'

export function AssignAgentSelect({
  taskId,
  teamId,
  asker,
  onAssigned,
  label = 'Assign to…',
}: {
  taskId: string
  teamId: string
  /** The person who asked for the task, when that is someone else. */
  asker?: { id: string; name: string | null } | null
  /** Fires after a successful hand-off so the host can refresh. */
  onAssigned?: (agentId: string) => void
  label?: string
}) {
  const { assign, assignToMe, assignToPerson } = useTaskActions()
  const agents = useFleetStore((s) => s.agents)
  // Filtered in a memo, not in the selector: a selector that builds a new array
  // on every call would never settle.
  const members = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])
  const [saving, setSaving] = useState(false)

  async function handleChange(picked: string) {
    if (!picked) return
    const name = members.find((a) => a.id === picked)?.name ?? 'the agent'
    setSaving(true)
    const ok =
      picked === ME
        ? await assignToMe(taskId)
        : picked === ASKER && asker
          ? await assignToPerson(taskId, asker.id, asker.name ?? 'them')
          : await assign(taskId, picked, name)
    setSaving(false)
    if (ok) onAssigned?.(picked)
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Select
        size="sm"
        aria-label="Assign to a person or an agent"
        data-testid="assign-agent-select"
        value={PLACEHOLDER}
        onChange={(v) => void handleChange(v)}
        disabled={saving}
        menuWidth={200}
      >
        <option value={PLACEHOLDER} disabled>
          {label}
        </option>
        <option value={ME}>You</option>
        {asker ? <option value={ASKER}>{asker.name ?? 'The person who asked'}</option> : null}
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
