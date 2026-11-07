// The card about agents waking each other on a job: on a Needs you card and in the task
// drawer. It asks once per job, the first time an agent's comment would start a teammate,
// and comes back only to lift a pause: the hourly cap, or two agents answering each other
// without end. Pressing it decides for the job, so a press is final, and a card someone
// else already answered says so.

import { useState } from 'react'

import {
  MAX_AGENT_WAKES_PER_HOUR,
  type AgentWakeCard,
  type AgentWakeChoice,
} from '@clawboo/board-core'

import { Button } from '@/features/shared/Button'
import { decideAgentWakes } from '@/lib/boardClient'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'

import { DASHBOARD_ONLY } from './boardStatus'

const REFUSED: Record<string, string> = {
  no_card: 'That has already been answered.',
  no_team: 'This task has no team to allow it in.',
  dashboard_only: DASHBOARD_ONLY,
}

const TEAMMATE = 'A teammate'

export function AgentWakesCard({
  card,
  teamId,
  onDecided,
}: {
  card: AgentWakeCard
  teamId: string | null
  onDecided: () => void
}) {
  const addToast = useToastStore((s) => s.addToast)
  const [busy, setBusy] = useState(false)
  const agents = useFleetStore((s) => s.agents)
  const nameOf = (id: string | null): string | null => agents.find((a) => a.id === id)?.name ?? null
  const from = nameOf(card.fromAgentId)
  const to = nameOf(card.toAgentId)

  const press = async (choice: AgentWakeChoice): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await decideAgentWakes(card.jobTaskId, choice)
    setBusy(false)
    if (result.ok) {
      onDecided()
      return
    }
    addToast({
      type: 'error',
      message: REFUSED[result.reason] ?? 'Couldn’t save that. Please try again.',
    })
    // Someone else answered: the board's next read takes the card away.
    if (result.reason === 'no_card') onDecided()
  }

  if (card.kind === 'ask') {
    return (
      <div data-testid="agent-wakes-card" className="flex flex-col gap-2">
        <p className="m-0 whitespace-pre-wrap break-words text-compact text-foreground">
          {from ?? TEAMMATE} wants to wake {to ?? 'a teammate'} on this job.
        </p>
        <p className="m-0 text-xs text-muted-foreground">
          Say yes and agents on this job can start each other with a comment, within limits. Until
          then, only you can.
        </p>
        {card.alsoWaiting ? (
          <p className="m-0 text-xs text-muted-foreground">
            {card.alsoWaiting === 1
              ? '1 other task is waiting on this answer, and it covers that one too.'
              : `${card.alsoWaiting} other tasks are waiting on this answer, and it covers those too.`}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void press('job')}>
            Allow on this job
          </Button>
          {teamId ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void press('team')}>
              Always allow in this team
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void press('no')}>
            No
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div data-testid="agent-wakes-card" className="flex flex-col gap-2">
      <p className="m-0 whitespace-pre-wrap break-words text-compact text-foreground">
        {card.kind === 'hourly_cap'
          ? `Agents on this job have started each other ${MAX_AGENT_WAKES_PER_HOUR} times this hour, so this one is paused.`
          : `${from ?? TEAMMATE} and ${to ?? 'a teammate'} keep waking each other, so this one is stopped.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void press('job')}>
          Let them carry on
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void press('no')}>
          No more on this job
        </Button>
      </div>
    </div>
  )
}
