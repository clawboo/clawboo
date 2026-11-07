// The card on a job that has started as many runs by itself as it may: on a Needs you card
// and in the task drawer. Carry on adds another lot, and Stop ends this job's runs and
// keeps it from starting more by itself, whatever else its room is doing. A press decides
// for the job, and a card someone else already answered says so.

import { useState } from 'react'

import type { JobLimitCard as JobLimit } from '@clawboo/board-core'

import { Button } from '@/features/shared/Button'
import { decideJobLimit } from '@/lib/boardClient'
import { notePersonCheck, PERSON_CHECK_REFUSED } from '@/lib/personCheckNotice'
import { useToastStore } from '@/stores/toast'

const REFUSED: Record<string, string> = {
  no_card: 'That has already been answered.',
}

export function JobLimitCard({ card, onDecided }: { card: JobLimit; onDecided: () => void }) {
  const addToast = useToastStore((s) => s.addToast)
  const [busy, setBusy] = useState(false)

  const press = async (decision: 'carry_on' | 'stop'): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await decideJobLimit(card.jobTaskId, decision)
    setBusy(false)
    if (result.ok) {
      onDecided()
      return
    }
    if (result.reason === 'person_only') notePersonCheck(PERSON_CHECK_REFUSED)
    else {
      addToast({
        type: 'error',
        message: REFUSED[result.reason] ?? 'Couldn’t save that. Please try again.',
      })
    }
    // Someone else answered: the board's next read takes the card away.
    if (result.reason === 'no_card') onDecided()
  }

  return (
    <div data-testid="job-limit-card" className="flex flex-col gap-2">
      <p className="m-0 whitespace-pre-wrap break-words text-compact text-foreground">
        This job has started {card.runs} runs by itself.
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        What it would start next is waiting for you. Carry on lets it start another 100. Stop ends
        the runs going under this job and starts nothing more by itself. Other jobs keep going. A
        Retry or a comment from you always starts work.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void press('carry_on')}
        >
          Carry on
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void press('stop')}>
          Stop
        </Button>
      </div>
    </div>
  )
}
