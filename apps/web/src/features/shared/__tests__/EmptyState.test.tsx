// EmptyState: the shared empty-state primitive behind about twenty surfaces. An
// `art` illustration (the Board's Boo) takes the icon disc's place; an `icon`
// alone draws the 56px disc; with neither, the title leads. The helper line uses
// the muted text token, never a faded foreground.

import { BooAvatar, TINTS } from '@clawboo/ui'
import { cleanup, render, screen } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'

import { axe } from '@/__vitest__/axe'

import { EmptyState } from '../EmptyState'

afterEach(() => cleanup())

const BOO = (
  <BooAvatar seed="clawboo-board-empty" size={56} tint={TINTS[3]} eyeShape={0} accessory="none" />
)

/** The EmptyState's own root element. */
function root(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild
  if (!(el instanceof HTMLElement)) throw new Error('no EmptyState root')
  return el
}

/** The 56px circular icon disc, if one is drawn. */
function disc(container: HTMLElement): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLElement>('div')).find(
      (el) => el.style.width === '56px' && el.style.height === '56px',
    ) ?? null
  )
}

describe('EmptyState', () => {
  it('draws the art in place of the icon disc, hidden from screen readers', () => {
    const { container } = render(<EmptyState art={BOO} title="No tasks yet" />)

    const first = root(container).firstElementChild as HTMLElement
    expect(first).toHaveAttribute('aria-hidden', 'true')
    const svg = first.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('width', '56')
    expect(disc(container)).toBeNull()
    expect(container.querySelector('.lucide')).toBeNull()

    // The art sits above the title.
    const title = screen.getByText('No tasks yet')
    expect(first.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('prefers the art when both art and an icon are given', () => {
    const { container } = render(<EmptyState art={BOO} icon={Inbox} title="No tasks yet" />)
    expect(disc(container)).toBeNull()
    expect(container.querySelector('.lucide-inbox')).toBeNull()
    expect(container.querySelectorAll('[aria-hidden="true"] svg')).toHaveLength(1)
  })

  it('draws the 56px disc with the icon when there is no art', () => {
    const { container } = render(<EmptyState icon={Inbox} title="Nothing here" />)

    const d = disc(container)
    expect(d).not.toBeNull()
    expect(d).toHaveAttribute('aria-hidden', 'true')
    expect(d?.style.borderRadius).toBe('999px')
    const icon = d?.querySelector('svg.lucide-inbox')
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('width', '26')
    expect(icon).toHaveAttribute('stroke-width', '1.75')
    expect(root(container).firstElementChild).toBe(d)
  })

  it('falls back to the icon disc when art is null', () => {
    const { container } = render(<EmptyState art={null} icon={Inbox} title="Nothing here" />)
    const d = disc(container)
    expect(d).not.toBeNull()
    expect(d?.querySelector('svg.lucide-inbox') ?? null).not.toBeNull()
  })

  it('colours the disc and icon by tone', () => {
    const { container } = render(<EmptyState icon={Inbox} tone="amber" title="Waiting" />)
    const d = disc(container)
    expect(d?.style.border).toContain('var(--amber-rgb)')
    expect(d?.querySelector('svg')).toHaveAttribute('stroke', 'var(--amber)')
  })

  it('leads with the title when there is neither art nor an icon', () => {
    const { container } = render(<EmptyState title="All clear" helper="Nothing waits on you." />)

    const first = root(container).firstElementChild
    expect(first).toHaveTextContent('All clear')
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('[aria-hidden]')).toBeNull()
    expect(disc(container)).toBeNull()
  })

  it('draws the helper in the muted text token', () => {
    render(<EmptyState icon={Inbox} title="No tasks yet" helper="Agents add tasks as they work." />)
    const helper = screen.getByText('Agents add tasks as they work.')
    expect(helper.style.color).toBe('var(--muted-foreground)')
    expect(helper.getAttribute('style') ?? '').not.toMatch(/foreground-rgb/)
  })

  it('renders a rich helper and the action, and nothing for a missing helper', () => {
    const { container, rerender } = render(
      <EmptyState
        title="No tasks yet"
        helper={
          <>
            Read <a href="#board">the board guide</a>.
          </>
        }
        action={<button type="button">New task</button>}
      />,
    )
    expect(screen.getByRole('link', { name: 'the board guide' })).toBeInTheDocument()
    const action = screen.getByRole('button', { name: 'New task' })
    const helper = screen.getByRole('link').parentElement as HTMLElement
    expect(helper.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    rerender(<EmptyState title="No tasks yet" />)
    // Only the title remains.
    expect(root(container).children).toHaveLength(1)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has no a11y violations with art', async () => {
    const { container } = render(
      <EmptyState
        art={BOO}
        title="No tasks yet"
        helper="Agents add tasks as they work."
        action={<button type="button">New task</button>}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
