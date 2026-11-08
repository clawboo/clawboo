// A one-to-one chat never shows a hand-off that did not happen.
//
// Nothing in most 1:1 chats acts on a `<delegate>` tag: there is no board and no team
// engine there. Boo Zero's 1:1 chat was taught the tag anyway, and the reply drew
// a "Delegated to @X" card for each one while it streamed, for work that never
// started. Such a chat now shows the block as a plain note that it was not handed
// off, while the reply streams and after it commits. A chat where a tag does start a
// task (a team's chat, a server-run Boo Zero's own) keeps its card.

import type { ComponentProps, ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { AssistantTurnCard, MessageList, StreamingCard, type RenderBlock } from '../chatComponents'

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

function renderList(
  blocks: RenderBlock[],
  streamingText: string | null,
  extra: Partial<Pick<ComponentProps<typeof MessageList>, 'handOffs' | 'cards'>> = {},
) {
  return renderUi(
    <MessageList
      blocks={blocks}
      streamingText={streamingText}
      agentId="bz"
      agentName="Boo Zero"
      isRunning={streamingText !== null}
      sessionKey="agent:bz:main"
      {...extra}
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
  expect(note).toHaveTextContent('This chat cannot hand off work')
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

  // Until the stream says this chat hands off, Boo Zero's chat draws this way too, and
  // the server may already have read a tag in a quote as a draft.
  it.each([
    ['code', 'Draft:\n\n```\n<delegate to="@Research Boo">find the numbers</delegate>\n```'],
    ['a quote', 'He wrote "<delegate to="@Research Boo">find the numbers</delegate>" once.'],
  ])('keeps a tag in %s as written, with no note', (_name, text) => {
    renderList([assistantTurn(text)], null)
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    expect(screen.getByText(/delegate to=/)).toBeInTheDocument()
    cleanup()
    renderList([], text)
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    expect(screen.getByText(/delegate to=/)).toBeInTheDocument()
  })

  it('reads a committed turn as written, as the streaming card does', () => {
    // A plan on the quote's line runs over lines; taking it out first would join the
    // quote to the tag's line and hide the note the streaming card drew.
    const text =
      'He said "draft: <plan>\n<step to="@A Boo">look</step>\n</plan> then ' +
      '<delegate to="@Research Boo">find the numbers</delegate> done" ok.'
    renderList([], text)
    expect(screen.getByTestId('not-handed-off-note')).toBeInTheDocument()
    cleanup()
    renderList([assistantTurn(text)], null)
    expect(screen.getByTestId('not-handed-off-note')).toBeInTheDocument()
    expect(screen.queryByText(/look/)).toBeNull()
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

  it('draws neither a card nor a note once the turn is committed', () => {
    // A committed turn drops the block from its prose and draws nothing inline.
    const block = assistantTurn(TAGGED)
    if (block.kind !== 'assistant-turn') throw new Error('expected an assistant turn')
    renderUi(<AssistantTurnCard block={block} agentId="bz" agentName="Boo Zero" teamId="T" />)
    expect(screen.queryByTestId('delegation-card')).toBeNull()
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    expect(screen.getByText(/On it\./)).toBeInTheDocument()
  })
})

describe('a 1:1 chat that acts on its hand-offs (a server-run Boo Zero)', () => {
  it('shows no note: a committed turn reads as prose, and the work shows as its card', () => {
    renderList([assistantTurn(TAGGED)], null, {
      handOffs: 'chat-card',
      cards: [{ id: 't1', at: 1_700_000_000_001, node: <div data-testid="a-card">a card</div> }],
    })
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    expect(screen.queryByText(/cannot hand off/)).toBeNull()
    expect(screen.getByText(/On it\./)).toBeInTheDocument()
    expect(screen.queryByText(/find the numbers/)).toBeNull()
    expect(screen.getByTestId('a-card')).toBeInTheDocument()
  })

  it('shows a card that says it is on its way while the reply streams', () => {
    renderList([], TAGGED, { handOffs: 'chat-card' })
    expect(screen.queryByTestId('not-handed-off-note')).toBeNull()
    // Nothing has started yet: the server decides once the reply ends.
    expect(screen.getByTestId('delegation-card')).toHaveTextContent('Handing off to')
    expect(screen.getByTestId('delegation-card')).not.toHaveTextContent('Delegated to')
  })

  it('draws no card for a tag in code while the reply streams: nothing starts from it', () => {
    renderList([], '```\n<delegate to="@Research Boo">find it</delegate>\n```', {
      handOffs: 'chat-card',
    })
    expect(screen.queryByTestId('delegation-card')).toBeNull()
    expect(screen.getByText(/delegate to=/)).toBeInTheDocument()
  })

  it('keeps a tag in code in the committed turn, and takes out only a real one', () => {
    const text =
      'Like so:\n\n```\n<delegate to="@A Boo">the example</delegate>\n```\n\n' +
      '<delegate to="@B Boo">the real one</delegate>'
    renderList([assistantTurn(text)], null, { handOffs: 'chat-card' })
    expect(screen.getByText(/the example/)).toBeInTheDocument()
    expect(screen.queryByText(/the real one/)).toBeNull()
  })

  it("a team's chat still strips every tag: its engine read them all", () => {
    const text = '```\n<delegate to="@A Boo">the example</delegate>\n```'
    renderUi(
      <AssistantTurnCard
        block={assistantTurn(text) as never}
        agentId="bz"
        agentName="Boo Zero"
        streaming={false}
        handOffs="card"
      />,
    )
    expect(screen.queryByText(/the example/)).toBeNull()
  })

  it('places a card by when it was made, among the messages', () => {
    const later = {
      ...assistantTurn('The later reply.'),
      anchorEntryId: 'a2',
      timestampMs: 1_700_000_000_500,
    }
    renderList([assistantTurn('The first reply.'), later], null, {
      handOffs: 'chat-card',
      cards: [
        { id: 'between', at: 1_700_000_000_100, node: <div>between card</div> },
        { id: 'end', at: 1_700_000_000_900, node: <div>end card</div> },
      ],
    })
    const order = screen.getByTestId('chat-message-list').textContent ?? ''
    expect(order.indexOf('The first reply.')).toBeLessThan(order.indexOf('between card'))
    expect(order.indexOf('between card')).toBeLessThan(order.indexOf('The later reply.'))
    expect(order.indexOf('The later reply.')).toBeLessThan(order.indexOf('end card'))
  })

  it('is not the empty state when all it has is a card', () => {
    renderList([], null, {
      handOffs: 'chat-card',
      cards: [{ id: 't1', at: 1, node: <div data-testid="a-card">a card</div> }],
    })
    expect(screen.getByTestId('a-card')).toBeInTheDocument()
    expect(screen.queryByText(/Say hi to/)).toBeNull()
  })
})
