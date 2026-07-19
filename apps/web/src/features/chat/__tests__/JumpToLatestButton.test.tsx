// JumpToLatestButton — the floating "scroll to latest / new messages" control
// shared by 1:1 chat (MessageList) and group chat (GroupChatPanel). The scroll
// math itself lives in `useChatAutoScroll` (jsdom has no real layout, so the
// pixel-level pinning is exercised in the browser); here we lock the button's
// three visible states + the click.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { JumpToLatestButton } from '../chatComponents'

afterEach(cleanup)

describe('JumpToLatestButton', () => {
  it('is mounted but hidden + out of the tab order while the user is at the bottom', () => {
    // Always mounted (CSS-transition hide, not unmount) so the fade can never
    // stall half-visible; when hidden it must not reach AT or the tab order.
    render(<JumpToLatestButton show={false} hasNew={false} onClick={() => {}} />)
    const btn = screen.getByTestId('jump-to-latest')
    expect(btn).toHaveAttribute('aria-hidden', 'true')
    expect(btn).toHaveAttribute('data-visible', 'false')
    expect(btn).toHaveAttribute('tabindex', '-1')
  })

  it('shows a plain "scroll to latest" control when scrolled up with no new messages', () => {
    render(<JumpToLatestButton show hasNew={false} onClick={() => {}} />)
    const btn = screen.getByTestId('jump-to-latest')
    expect(btn).toHaveAttribute('aria-label', 'Scroll to latest')
    expect(btn).toHaveAttribute('data-visible', 'true')
    expect(btn).toHaveAttribute('aria-hidden', 'false')
    expect(screen.queryByText('New messages')).toBeNull()
  })

  it('upgrades to a "New messages" pill when fresh content arrived while away', () => {
    render(<JumpToLatestButton show hasNew onClick={() => {}} />)
    expect(screen.getByTestId('jump-to-latest')).toHaveAttribute(
      'aria-label',
      'Jump to new messages',
    )
    expect(screen.getByText('New messages')).toBeInTheDocument()
  })

  it('invokes onClick when pressed', async () => {
    const onClick = vi.fn()
    render(<JumpToLatestButton show hasNew={false} onClick={onClick} />)
    await userEvent.click(screen.getByTestId('jump-to-latest'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
