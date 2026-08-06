// LoadEarlierButton — the control that reveals the hidden head of a windowed
// timeline. Unlike `JumpToLatestButton` it lives INSIDE the scroll content, so
// the content it reveals pushes it out of the way instead of it floating over
// the oldest message. The window arithmetic itself is covered in
// `renderWindow.test.ts`; here we lock the visible contract and the click.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LoadEarlierButton } from '../chatComponents'

afterEach(cleanup)

describe('LoadEarlierButton', () => {
  it('labels itself with the number of hidden items', () => {
    render(<LoadEarlierButton hiddenCount={42} onClick={() => {}} />)
    const btn = screen.getByTestId('load-earlier')
    expect(btn).toHaveAttribute('aria-label', 'Load earlier messages (42 hidden)')
    expect(btn).toHaveTextContent('42')
  })

  it('is a real button, so keyboard users reach it', () => {
    render(<LoadEarlierButton hiddenCount={1} onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /load earlier messages/i })).toBeInTheDocument()
  })

  it('invokes onClick when pressed', async () => {
    const onClick = vi.fn()
    render(<LoadEarlierButton hiddenCount={10} onClick={onClick} />)
    await userEvent.click(screen.getByTestId('load-earlier'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<LoadEarlierButton hiddenCount={10} onClick={() => {}} />)
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
