// Move an agent to another team. The server does the whole move in one step
// (POST /api/agents/:agentId/move): the agent's team, its unstarted tasks on the
// old team, its own routines, its old rooms and its session state. This dialog
// only picks the team and says what happens.

import { useId, useMemo, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

/** What each refusal means, in words a person can act on. */
const REFUSALS: Record<string, string> = {
  agent_leads_team: 'It leads its team. Choose another lead for that team first.',
  agent_busy: 'It has a task in progress or in review. Try again when that task is done.',
  agent_is_boo_zero: 'Boo Zero leads every team and does not join one.',
  team_archived: 'That team is archived. Unarchive it first.',
  team_not_found: 'That team no longer exists.',
  agent_not_found: 'This agent no longer exists.',
  same_team: 'It is already in that team.',
}

interface MoveResponse {
  ok?: boolean
  error?: string
  tasksHandedBack?: number
  routinesMoved?: number
  routinesPaused?: number
}

export function MoveAgentDialog({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string
  agentName: string
  onClose: () => void
}) {
  const headingId = useId()
  const currentTeamId = useFleetStore((s) => s.agents.find((a) => a.id === agentId)?.teamId ?? null)
  const allTeams = useTeamStore((s) => s.teams)
  const teams = useMemo(
    () => allTeams.filter((t) => !t.isArchived && t.id !== currentTeamId),
    [allTeams, currentTeamId],
  )
  const fromName = allTeams.find((t) => t.id === currentTeamId)?.name ?? null
  const [teamId, setTeamId] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const move = async (): Promise<void> => {
    if (!teamId) return
    setMoving(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId }),
      })
      const body = (await res.json().catch(() => ({}))) as MoveResponse
      if (!res.ok || !body.ok) {
        setError(REFUSALS[body.error ?? ''] ?? 'The move failed. Nothing changed.')
        return
      }
      useFleetStore.setState((st) => ({
        agents: st.agents.map((a) => (a.id === agentId ? { ...a, teamId } : a)),
      }))
      void hydrateTeams()
      const toName = teams.find((t) => t.id === teamId)?.name ?? 'the team'
      const handed = body.tasksHandedBack ?? 0
      const paused = body.routinesPaused ?? 0
      const from = fromName ?? 'its old team'
      const parts = [`Moved ${agentName} to ${toName}.`]
      if (handed > 0) {
        parts.push(
          `${handed} unstarted task${handed === 1 ? '' : 's'} stay on ${from}'s board, unassigned.`,
        )
      }
      if (paused > 0) {
        parts.push(
          `${paused} routine${paused === 1 ? '' : 's'} tied to ${from}'s tasks ${paused === 1 ? 'is' : 'are'} paused there.`,
        )
      }
      useToastStore.getState().addToast({ type: 'success', message: parts.join(' ') })
      onClose()
    } catch {
      setError('The move failed. Nothing changed.')
    } finally {
      setMoving(false)
    }
  }

  return (
    <Modal
      open
      labelledBy={headingId}
      onClose={onClose}
      dismissible={!moving}
      data-testid="move-agent-dialog"
      scrimClassName="p-6"
      panelClassName="flex w-[min(420px,100%)] flex-col gap-3 rounded-2xl border border-border bg-surface p-5"
      panelStyle={{ boxShadow: 'var(--shadow-overlay)' }}
    >
      <h2 id={headingId} className="m-0 text-[15px] font-semibold text-foreground">
        Move {agentName} to another team
      </h2>
      <p className="m-0 text-[12px] leading-relaxed text-foreground/55">
        Its routines move with it. Tasks it has not started stay on its old team&apos;s board,
        unassigned; finished work stays where it was done.
      </p>
      {teams.length === 0 ? (
        <p className="m-0 text-[13px] text-foreground/70">
          There is no other active team to move to.
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Team"
          className="flex max-h-[260px] flex-col gap-1 overflow-y-auto"
        >
          {teams.map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-foreground hover:bg-foreground/[0.05]"
            >
              <input
                type="radio"
                name={`${headingId}-team`}
                value={t.id}
                checked={teamId === t.id}
                onChange={() => setTeamId(t.id)}
              />
              <span aria-hidden>{t.icon}</span>
              <span>{t.name}</span>
            </label>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={moving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void move()}
          disabled={!teamId || moving}
          loading={moving}
        >
          Move
        </Button>
      </div>
    </Modal>
  )
}
