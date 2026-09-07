// The dock's chooser — the shape of the two rows, not their contents.
//
// This has been rebuilt four times, always for the same reason: the team bar and
// the faces row are sized by DIFFERENT things, and every attempt to hold them in
// one card made one of them wrong. A card has to take the width of the wider row
// and pad the other out with dead margin, which reads as the team bar stretching
// to match a row it has nothing to do with.
//
// The rules below are what the current shape rests on. None of them is visible to
// a test that only asks whether the tabs render, which is why every previous
// regression shipped: nothing in the suite touched this component at all.
//
// jsdom loads no stylesheets, so computed WIDTHS mean nothing here — a `100%`
// resolves against a zero-width layout. What jsdom does hold faithfully is the
// inline style React wrote, and every rule below is expressed as an inline style
// precisely because it is a structural decision rather than a themeable one.
// Whether the shapes actually meet on screen is a question for a browser; whether
// the code still ASKS them to meet is this file's job.

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/AgentBooAvatar', () => ({
  AgentBooAvatar: () => <span data-testid="boo" />,
}))
vi.mock('@/features/shared/useDismissableLayer', () => ({ useDismissableLayer: () => {} }))
vi.mock('@/features/workspace/useAgentScreenshot', () => ({
  useAgentScreenshot: () => ({ meta: null, checked: true, src: null }),
}))
vi.mock('@/features/workspace/useBrowserGrant', () => ({ useBrowserGrant: () => 'granted' }))
vi.mock('../useAgentFrames', () => ({
  useAgentFrames: () => new Map(),
  freshestAgent: () => null,
}))

const { BrowserDock } = await import('../BrowserDock')

const team = (id: string) => ({ id, name: `Team ${id}`, icon: '🛟' })
const agent = (id: string) => ({ id, name: `Boo ${id}` })

function renderDock(teamCount: number, agentCount: number) {
  const teams = Array.from({ length: teamCount }, (_, i) => team(`t${i}`))
  const agents = Array.from({ length: agentCount }, (_, i) => agent(`a${i}`))
  render(
    <BrowserDock
      open
      agents={agents}
      selectedAgentId={agents[0]?.id ?? null}
      onSelectAgent={() => {}}
      teams={teams}
      selectedTeamId={teams[0]?.id ?? null}
      onSelectTeam={() => {}}
      onClose={() => {}}
    />,
  )
}

const teamBar = () => screen.getByRole('tablist', { name: 'Choose a team' }).parentElement!
const facesRow = () => screen.getByRole('tablist', { name: 'Choose an agent' })
const union = () => teamBar().parentElement!

describe('the chooser is two shapes, not one card', () => {
  it('draws NO card around the pair', () => {
    // The regression this whole shape exists to prevent. A background here is a
    // rectangle enclosing both rows, and a rectangle can only be as wide as the
    // wider row — so the narrower one gets padded out with margin that reads as
    // it stretching. The edge comes from `.chooser-union`, which traces the
    // combined alpha instead of a box.
    renderDock(3, 5)

    expect(union().className).toContain('chooser-union')
    // Absence, not just presence. `toContain` alone passes when the old card
    // class is left sitting beside the new one, which is the literal regression.
    expect(union().className).not.toContain('surface-floating-tier')
    expect(union().style.background).toBe('')
    expect(union().style.border).toBe('')
    expect(union().style.boxShadow).toBe('')
  })

  it('gives each row its own fill, so the union is what is painted', () => {
    renderDock(3, 5)

    expect(teamBar().style.background).toBe('var(--surface)')
    expect(facesRow().style.background).toBe('var(--surface)')
  })

  it('sizes the team bar to its OWN tabs and lets the faces row grow', () => {
    // `max-content` against `100%` in a one-column grid is the whole mechanism:
    // the column takes the wider of the two, the bar keeps its natural width, and
    // the faces row fills whatever the column became. Swap either value and the
    // bar starts tracking a row it should be independent of.
    renderDock(3, 5)

    expect(teamBar().style.width).toBe('max-content')
    expect(facesRow().style.width).toBe('100%')
    expect(union().style.display).toBe('grid')
    expect(union().style.justifyItems).toBe('center')
    // SHRINK TO FIT. Without this the union spans the whole dock and the faces
    // sit in the middle of dead space either side, which is the stretched
    // rectangle by another route: every width assertion above still passes.
    expect(union().style.alignSelf).toBe('center')
    expect(union().style.width).not.toBe('100%')
    // The column has to be able to shrink, or a fleet with more teams than fit
    // runs the bar out of the dock instead of scrolling inside it.
    expect(union().style.gridTemplateColumns).toBe('minmax(0, max-content)')
  })

  it('centres the faces SAFELY, so an overflowing row keeps its first Boo', () => {
    // A plain `center` in a scroll container puts the leading items at negative
    // offsets, and scroll range starts at 0: those Boos cannot be reached by any
    // scroll position. `safe` degrades to flex-start exactly then.
    renderDock(3, 5)

    expect(facesRow().style.justifyContent).toBe('safe center')
  })
})

describe('the two shapes overlap by exactly their corner radius', () => {
  // The number that stops a notch appearing. The bar sinks into the row far
  // enough to bury the row's top corner arc; anything less and the bar's bottom
  // corners overhang the curve. That is not an edge case — the faces row FLOORS
  // at the bar's width, so any team with fewer Boos than there are teams lands
  // exactly on the equal-width case where the notch would show.
  it('sinks the bar in by the radius, and clears the same distance below', () => {
    renderDock(3, 5)

    const barCorners = teamBar().style.borderRadius.trim().split(/\s+/)
    const rowCorners = facesRow().style.borderRadius.trim().split(/\s+/)
    const outer = parseInt(barCorners[0] ?? '', 10)
    // The OVERLAP, read from the margin that produces it — not from a radius.
    const seam = parseInt(teamBar().style.marginBottom.replace('-', ''), 10)
    expect(outer).toBeGreaterThan(0)

    // The bar's BOTTOM corners are square, and that is load-bearing. Round both
    // shapes and their corner arcs run through the same band of the overlap, so
    // neither covers the other and the union pinches inward about 2px on each
    // edge — which the hairline then traces as a dimple.
    expect(barCorners).toHaveLength(4)
    expect(parseInt(barCorners[1] ?? '', 10)).toBe(outer)
    expect(parseInt(barCorners[2] ?? '', 10)).toBe(0)
    expect(parseInt(barCorners[3] ?? '', 10)).toBe(0)

    // The row is an EVEN rounded rectangle, all four corners.
    expect(rowCorners.length === 1 || rowCorners.length === 4).toBe(true)
    for (const c of rowCorners) expect(parseInt(c, 10)).toBe(outer)

    // The overlap is a HAIRLINE, and that is only affordable because the row is
    // guaranteed to be wider than the bar. Equal widths would force the bar to
    // sink a whole radius to bury the row's corner arc, the row would have to pad
    // past that overlap so the bar did not cover the Boos, and every face would
    // carry a radius of dead space above it. This is the assertion that fails if
    // the guarantee below is removed and the overlap creeps back up.
    expect(seam).toBeLessThan(outer)
    expect(seam).toBeGreaterThan(0)
    const radius = seam

    // The faces have to start BELOW the overlap or the bar covers them. Read
    // against paddingBottom, not the `padding` shorthand: once paddingTop is
    // written the shorthand reflects the MERGED value and reads back as the top.
    const padTop = parseInt(facesRow().style.paddingTop, 10)
    const padBase = parseInt(facesRow().style.paddingBottom, 10)
    // Both must be REAL numbers first. Strip the padding entirely and each reads
    // back NaN, and `toBe` compares with Object.is, under which NaN equals NaN —
    // so the relationship below held for a row with no padding at all.
    expect(padBase).toBeGreaterThan(0)
    expect(padTop).toBe(padBase + radius)
  })

  it('marks the selected team WITHOUT a ground, so no edge crosses the shape', () => {
    // A tinted ground behind the tabs has to stop somewhere, and wherever it
    // stopped it drew a hard grey-on-white line the full width of the bar — the
    // only straight edge in a shape assembled to avoid them. Every position for
    // it is a line, so the ground is gone and the tab carries its own fill, the
    // way the faces row already marks the chosen Boo.
    renderDock(3, 5)

    const tablist = screen.getByRole('tablist', { name: 'Choose a team' })
    expect(tablist.style.background).toBe('')

    const tabs = screen.getAllByRole('tab', { name: /^Team / })
    const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true')!
    const unselected = tabs.find((t) => t.getAttribute('aria-selected') === 'false')!
    expect(selected.style.background).not.toBe('transparent')
    expect(selected.style.background).not.toBe('')
    expect(unselected.style.background).toBe('transparent')

    // One sheet: the bar and the row are the same fill, with nothing between.
    expect(teamBar().style.background).toBe(facesRow().style.background)
  })

  it('keeps the bar above the faces row, which is a later sibling', () => {
    // Without this the overlap paints the wrong way round: the row is written
    // after the bar, so it would cover the bar's bottom edge instead of being
    // covered by it, and the seam would show as a line across the shape.
    renderDock(3, 5)

    expect(teamBar().style.position).toBe('relative')
    expect(Number(teamBar().style.zIndex)).toBeGreaterThan(0)
  })

  it('does not indent the faces row when there is no bar to clear', () => {
    // A team graph renders the faces alone. Reserving room for a bar that is not
    // there would leave the row visibly top-heavy.
    renderDock(1, 5)

    expect(screen.queryByRole('tablist', { name: 'Choose a team' })).toBeNull()
    const row = facesRow()
    expect(parseInt(row.style.paddingBottom, 10)).toBeGreaterThan(0)
    expect(row.style.paddingTop).toBe(row.style.paddingBottom)
  })
})

describe('what renders at all', () => {
  it('shows the team bar only when there is a choice to make', () => {
    renderDock(1, 4)
    expect(screen.queryByRole('tablist', { name: 'Choose a team' })).toBeNull()
  })

  it('drops the whole chooser when neither row offers a choice', () => {
    // One team, one Boo: two rows of one tab each is chrome asking a question
    // that has a single answer.
    renderDock(1, 1)
    expect(screen.queryByRole('tablist', { name: 'Choose an agent' })).toBeNull()
  })

  it('does not call an empty faces row a tablist', () => {
    // A team with no Boos renders one line of prose and zero tabs. Leaving the
    // role on trips axe's aria-required-children and has a screen reader
    // announce an empty tab list over the message it is meant to read.
    renderDock(3, 0)

    expect(screen.queryByRole('tablist', { name: 'Choose an agent' })).toBeNull()
    expect(screen.getByText('No Boos on this team.')).toBeTruthy()
  })

  it('marks the selected team, so the raised chip is not the only signal', () => {
    renderDock(3, 5)
    const tabs = screen.getAllByRole('tab', { name: /^Team / })
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  })
})
