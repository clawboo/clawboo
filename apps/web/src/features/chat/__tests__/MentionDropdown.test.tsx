// The @mention autocomplete list, and the composer flow that drives it.
//
// The component was previously duplicated: a standalone file that nothing ever
// imported, plus a private copy inside MessageComposer. Only the copy was
// tested (indirectly), so the pair could — and did — drift. These cover the one
// surviving component directly, plus the type-@ → pick → spliced-draft round
// trip that had no coverage at all.

import type { ReactElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { MessageComposer } from '../chatComponents'
import { MentionDropdown, type MentionCandidate } from '../MentionDropdown'

afterEach(() => cleanup())

// AgentBooAvatar reads the theme to tint the Boo.
const renderUI = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const AGENTS: MentionCandidate[] = [
  { id: 'a1', name: 'Coder' },
  { id: 'a2', name: 'Reviewer' },
]
const TEAMS: MentionCandidate[] = [{ id: 't1', name: 'Launch', icon: '🚀', color: '#ff0055' }]

describe('MentionDropdown', () => {
  it('renders one option per candidate and marks the highlighted row', () => {
    renderUI(
      <MentionDropdown agents={AGENTS} selectedIndex={1} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('Coder')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('renders a team candidate as its emoji, not a Boo avatar', () => {
    renderUI(
      <MentionDropdown agents={TEAMS} selectedIndex={0} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByRole('option')).toHaveTextContent('🚀')
    expect(screen.getByRole('option')).toHaveTextContent('Launch')
  })

  it('selects on mousedown without stealing focus from the composer', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    renderUI(
      <>
        <input aria-label="composer" autoFocus />
        <MentionDropdown agents={AGENTS} selectedIndex={0} onSelect={onSelect} onClose={vi.fn()} />
      </>,
    )
    await user.click(screen.getByRole('option', { name: /Coder/ }))
    expect(onSelect).toHaveBeenCalledWith('Coder')
    // preventDefault on mousedown is what keeps the caret where it was.
    expect(screen.getByLabelText('composer')).toHaveFocus()
  })

  it('closes on a press outside, and only itself', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderUI(
      <>
        <button>elsewhere</button>
        <MentionDropdown agents={AGENTS} selectedIndex={0} onSelect={vi.fn()} onClose={onClose} />
      </>,
    )
    await user.click(screen.getByRole('option', { name: /Coder/ }))
    expect(onClose).not.toHaveBeenCalled() // inside is never a dismissal

    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('MessageComposer @mention flow', () => {
  it('opens on @, filters as you type, and splices the pick into the draft', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    renderUI(<MessageComposer onSend={onSend} disabled={false} mentionAgents={AGENTS} />)
    const box = screen.getByRole('textbox')

    await user.type(box, '@')
    expect(await screen.findByTestId('mention-dropdown')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(2)

    await user.type(box, 'Rev')
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))

    await user.click(screen.getByRole('option', { name: /Reviewer/ }))
    await waitFor(() => expect(box).toHaveValue('@Reviewer '))
    expect(screen.queryByTestId('mention-dropdown')).toBeNull()
  })

  it('Escape closes the list without sending or clearing the draft', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    renderUI(<MessageComposer onSend={onSend} disabled={false} mentionAgents={AGENTS} />)
    const box = screen.getByRole('textbox')

    await user.type(box, 'ping @Co')
    expect(await screen.findByTestId('mention-dropdown')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('mention-dropdown')).toBeNull())
    expect(box).toHaveValue('ping @Co')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('arrow keys move the highlight and Enter commits it', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    renderUI(<MessageComposer onSend={onSend} disabled={false} mentionAgents={AGENTS} />)
    const box = screen.getByRole('textbox')

    await user.type(box, '@')
    await screen.findByTestId('mention-dropdown')
    await user.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'),
    )

    await user.keyboard('{Enter}')
    await waitFor(() => expect(box).toHaveValue('@Reviewer '))
    // Enter committed the mention, it did not send the message.
    expect(onSend).not.toHaveBeenCalled()
  })
})
