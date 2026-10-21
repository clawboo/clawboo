// PanelHeader: the header every dashboard panel shares. The title is the page's
// h1; the subtitle uses the muted text token (text-muted-foreground), never a
// faded foreground, so it keeps 4.5:1 in both themes. The token contrast test
// checks globals.css, not class names, so this is what catches a revert.

import { cleanup, render, screen } from '@testing-library/react'
import { KanbanSquare } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'

import { axe } from '@/__vitest__/axe'

import { PanelHeader } from '../PanelHeader'

afterEach(() => cleanup())

/** Text-colour utilities built from an opacity of a colour, e.g. text-foreground/50. */
function fadedTextClasses(el: Element): string[] {
  return Array.from(el.classList).filter((c) => /^text-(foreground|secondary)\//.test(c))
}

describe('PanelHeader', () => {
  it('draws the subtitle in the muted text token', () => {
    render(<PanelHeader title="Board" subtitle="Every task your agents are working on" />)
    const subtitle = screen.getByText('Every task your agents are working on')
    expect(subtitle.tagName).toBe('P')
    expect(subtitle).toHaveClass('text-muted-foreground')
    expect(fadedTextClasses(subtitle)).toEqual([])
    expect(subtitle.getAttribute('style')).toBeNull()
  })

  it('renders the title as the page heading', () => {
    render(<PanelHeader title="Board" subtitle="Tasks" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Board' })).toHaveClass('text-foreground')
  })

  it('renders no subtitle line and no border by default', () => {
    const { container } = render(<PanelHeader title="Board" />)
    expect(container.querySelector('p')).toBeNull()
    expect(container.firstElementChild).not.toHaveClass('border-b')
  })

  it('renders the icon, the actions and the border', () => {
    const { container } = render(
      <PanelHeader
        title="Board"
        icon={KanbanSquare}
        actions={<button type="button">Refresh</button>}
        border
        className="extra"
      />,
    )
    const header = container.firstElementChild
    expect(header).toHaveClass('border-b', 'border-border', 'extra')
    expect(container.querySelector('svg.lucide')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PanelHeader
        title="Board"
        subtitle="Tasks"
        icon={KanbanSquare}
        actions={<button type="button">Refresh</button>}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
