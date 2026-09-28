// A routine posts the person's own instructions into team chat on a schedule.
// The bubble names the routine instead of reading as a live "You".

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TranscriptEntry } from '@clawboo/protocol'

import { UserMessageCard } from '../chatComponents'

afterEach(() => cleanup())

const ENTRY: TranscriptEntry = {
  entryId: 'e1',
  role: 'user',
  kind: 'user',
  text: 'Summarize what shipped yesterday.',
  sessionKey: 'agent:bz:team:t1',
  runId: null,
  source: 'local-send',
  timestampMs: 1_750_000_000_000,
  sequenceKey: 1,
  confirmed: true,
  fingerprint: 'f1',
}

describe('UserMessageCard', () => {
  it('names the routine that posted the message, and who it went to', () => {
    render(
      <UserMessageCard
        entry={{
          ...ENTRY,
          origin: { kind: 'routine', routineId: 'r1', routineName: 'Morning briefing' },
        }}
        targetAgentName="Boo Zero"
      />,
    )
    expect(screen.getByTestId('user-message-routine')).toHaveTextContent(
      'Routine · Morning briefing → Boo Zero',
    )
    expect(screen.queryByText(/^You/)).toBeNull()
    expect(screen.getByText('Summarize what shipped yesterday.')).toBeInTheDocument()
  })

  it('a message the person typed still reads as theirs', () => {
    render(<UserMessageCard entry={ENTRY} targetAgentName="Boo Zero" />)
    expect(screen.getByText('You → Boo Zero')).toBeInTheDocument()
    expect(screen.queryByTestId('user-message-routine')).toBeNull()
  })
})
