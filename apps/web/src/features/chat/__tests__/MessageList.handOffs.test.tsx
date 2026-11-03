// A one-to-one chat never shows a hand-off that did not happen.
//
// Nothing in a 1:1 chat acts on a `<delegate>` tag: there is no board and no team
// engine there. Boo Zero's 1:1 chat was taught the tag anyway, and the reply drew
// a "Delegated to @X" card for each one while it streamed, for work that never
// started. The 1:1 list now shows such a block as a plain note that it was not
// handed off, while the reply streams and after it commits. The group chat,
// where a tag does start a task, keeps its card.

import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { MessageList, StreamingCard, type RenderBlock } from '../chatComponents'

afterEach(cleanup)

beforeEach(() => {
  useFleetStore.setState({ agents: [], selectedAgentId: null } as never)
  useBooZeroStore.setState({ booZeroAgentId: null })
  useTeamStore.setState({ teams: [] } as never)
})

const renderUi = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const TAGGED = 'On it. <delegate to="@Research Boo">find the numbers</delegate>'

function assistantTurn(text: string): RenderBlock {
  const entry: TranscriptEntry = {
    entryId: 'a1',
    role: 'assistant',
    kind: 'assistant',
    text,
    sessionKey: 'agent:bz:main',
    runId: null,
    source: 'local-send',
    timestampMs: 1_700_000_000_000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
  }
  return {
    kind: 'assistant-turn',
    assistant: entry,
    thinking: [],
    tools: [],
    timestampMs: entry.timestampMs,
    anchorEntryId: entry.entryId,
  }
}

function renderList(blocks: RenderBlock[], streamingText: string | null) {
  return renderUi(
    <MessageList
      blocks={blocks}
      streamingText={streamingText}
      agentId="bz"
      agentName="Boo Zero"
      isRunning={streamingText !== null}
      sessionKey="agent:bz:main"
    />,
  )
}

function expectNotHandedOff(): void {
  expect(screen.queryByTestId('delegation-card')).toBeNull()
  expect(screen.queryByText('Delegated to')).toBeNull()
  const note = screen.getByTestId('not-handed-off-note')
  expect(note).toHaveTextContent('Not handed off')
  expect(note).toHaveTextContent('@Research Boo')
  expect(note).toHaveTextContent('find the numbers')
  expect(note).toHaveTextContent('Hand-offs work only in a team’s chat')
}

describe('a 1:1 chat with a <delegate> block in the reply', () => {
  it('shows a not-handed-off note while the reply streams, not a Delegated card', () => {
    renderList([], TAGGED)
    expectNotHandedOff()
    expect(screen.getByText(/On it\./)).toBeInTheDocument()
  })

  it('shows the same note once the reply is committed', () => {
    renderList([assistantTurn(TAGGED)], null)
    expectNotHandedOff()
    expect(screen.getByText(/On it\./)).toBeInTheDocument()
  })

  it('renders a reply with no tag as plain prose', () => {
    renderList([assistantTurn('Here is the summary you asked for.')], null)
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    expect(screen.getByText('Here is the summary you asked for.')).toBeInTheDocument()
  })
})

describe('the group chat, where a <delegate> tag starts a task', () => {
  it('keeps its Delegated card while the lead streams', () => {
    renderUi(<StreamingCard text={TAGGED} agentId="bz" agentName="Boo Zero" />)
    expect(screen.getByTestId('delegation-card')).toHaveTextContent('Delegated to')
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
  })
})
