// RollingCount: the number in every board column header and both Needs you counts.
// A change rolls the old value out and the new one in (up for more, down for
// less); the first render and a quiet change do not roll; the outgoing copy is
// hidden from screen readers and leaves the DOM when the 200ms roll ends.
//
// Each count sits inside a button here so the accessible name (which skips
// aria-hidden nodes) reads exactly what a screen reader would announce.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RollingCount } from '../RollingCount'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Count(props: { value: number; quiet?: boolean }) {
  return (
    <button type="button" data-testid="count">
      <RollingCount value={props.value} quiet={props.quiet} />
    </button>
  )
}

/** The RollingCount's own outer span. */
function root(): HTMLElement {
  const el = screen.getByTestId('count').firstElementChild
  if (!(el instanceof HTMLElement)) throw new Error('no RollingCount root')
  return el
}

/** The copy that carries the current value (the one screen readers hear). */
function incoming(): HTMLElement {
  const el = root().firstElementChild
  if (!(el instanceof HTMLElement)) throw new Error('no incoming span')
  return el
}

/** The aria-hidden copy of the previous value, present only while it rolls out. */
function outgoing(): HTMLElement | null {
  return root().querySelector<HTMLElement>('[aria-hidden="true"]')
}

function rollClasses(): string[] {
  return Array.from(root().querySelectorAll('[class]')).flatMap((el) =>
    Array.from(el.classList).filter((c) => c.startsWith('board-roll-')),
  )
}

describe('RollingCount', () => {
  it('shows the value on first render without rolling', () => {
    render(<Count value={3} />)
    expect(root()).toHaveClass('board-roll')
    expect(root().children).toHaveLength(1)
    expect(incoming()).toHaveTextContent('3')
    expect(incoming().getAttribute('class')).toBeNull()
    expect(outgoing()).toBeNull()
    expect(rollClasses()).toEqual([])
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument()
  })

  it('shows zero rather than nothing', () => {
    render(<Count value={0} />)
    expect(screen.getByRole('button', { name: '0' })).toBeInTheDocument()
  })

  it('rolls up when the value grows, with the old value hidden from screen readers', () => {
    const { rerender } = render(<Count value={3} />)
    rerender(<Count value={5} />)

    expect(incoming()).toHaveTextContent('5')
    expect(incoming()).toHaveClass('board-roll-in-up')
    const out = outgoing()
    expect(out).not.toBeNull()
    expect(out).toHaveTextContent('3')
    expect(out).toHaveClass('board-roll-out-up')
    expect(rollClasses().sort()).toEqual(['board-roll-in-up', 'board-roll-out-up'])

    // The DOM holds both numbers mid-roll, but only the new one is announced.
    expect(root()).toHaveTextContent('53')
    expect(screen.getByRole('button', { name: '5' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /3/ })).toBeNull()
  })

  it('rolls down when the value shrinks', () => {
    const { rerender } = render(<Count value={5} />)
    rerender(<Count value={2} />)

    expect(incoming()).toHaveTextContent('2')
    expect(incoming()).toHaveClass('board-roll-in-down')
    expect(outgoing()).toHaveTextContent('5')
    expect(outgoing()).toHaveClass('board-roll-out-down')
    expect(rollClasses().sort()).toEqual(['board-roll-in-down', 'board-roll-out-down'])
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument()
  })

  it('rolls up from zero', () => {
    const { rerender } = render(<Count value={0} />)
    rerender(<Count value={1} />)
    expect(incoming()).toHaveClass('board-roll-in-up')
    expect(outgoing()).toHaveTextContent('0')
  })

  it('does not roll when the value is unchanged', () => {
    const { rerender } = render(<Count value={4} />)
    rerender(<Count value={4} />)
    expect(outgoing()).toBeNull()
    expect(rollClasses()).toEqual([])
  })

  it('shows a quiet change without rolling', () => {
    const { rerender } = render(<Count value={3} />)
    rerender(<Count value={9} quiet />)

    expect(root().children).toHaveLength(1)
    expect(incoming()).toHaveTextContent('9')
    expect(outgoing()).toBeNull()
    expect(rollClasses()).toEqual([])
    expect(screen.getByRole('button', { name: '9' })).toBeInTheDocument()
  })

  it('rolls the next change from the value a quiet change showed', () => {
    const { rerender } = render(<Count value={3} />)
    rerender(<Count value={9} quiet />)
    rerender(<Count value={10} />)

    // From 9 (what was on screen), not 3 (the last value that rolled).
    expect(incoming()).toHaveTextContent('10')
    expect(incoming()).toHaveClass('board-roll-in-up')
    expect(outgoing()).toHaveTextContent('9')
    expect(screen.getByRole('button', { name: '10' })).toBeInTheDocument()
  })

  it('does not start a roll when only quiet flips back off', () => {
    const { rerender } = render(<Count value={6} quiet />)
    rerender(<Count value={6} />)
    expect(outgoing()).toBeNull()
    expect(rollClasses()).toEqual([])
  })

  it('clears the roll after 200ms, leaving only the new value', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Count value={3} />)
    rerender(<Count value={5} />)

    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(outgoing()).toHaveTextContent('3')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(outgoing()).toBeNull()
    expect(root().children).toHaveLength(1)
    expect(incoming()).toHaveTextContent('5')
    expect(rollClasses()).toEqual([])
    expect(screen.getByRole('button', { name: '5' })).toBeInTheDocument()
  })

  it('restarts the roll on a change mid-roll, from the value just shown', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Count value={3} />)
    rerender(<Count value={5} />)
    const firstIncoming = incoming()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    rerender(<Count value={2} />)

    // A fresh incoming copy, so its enter animation plays again.
    expect(incoming()).not.toBe(firstIncoming)
    expect(incoming()).toHaveTextContent('2')
    expect(incoming()).toHaveClass('board-roll-in-down')
    expect(outgoing()).toHaveTextContent('5')
    expect(outgoing()).toHaveClass('board-roll-out-down')
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument()

    // The first roll's timer no longer ends the second roll early.
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(outgoing()).toHaveTextContent('5')

    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(outgoing()).toBeNull()
    expect(incoming()).toHaveTextContent('2')
  })

  it('clears its timer when unmounted mid-roll', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(<Count value={1} />)
    rerender(<Count value={2} />)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the caller class and style on its root', () => {
    render(
      <RollingCount
        value={7}
        className="font-data tabular-nums text-muted-foreground"
        style={{ minWidth: 12 }}
      />,
    )
    const el = screen.getByText('7').parentElement
    expect(el).toHaveClass('board-roll', 'font-data', 'tabular-nums', 'text-muted-foreground')
    expect(el).toHaveStyle({ minWidth: '12px' })
  })
})
