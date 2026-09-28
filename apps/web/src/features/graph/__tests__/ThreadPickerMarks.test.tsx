// The chooser's three marks.
//
// The property worth locking is that the connectors mark draws the REAL marks it
// was given rather than a fixed illustration, because that is the whole reason
// it replaced a lucide glyph. The other is that each fan fits inside its tile:
// one as wide as the tile has its outer marks cut off by the rounded corners.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConnectorsMark, NewAgentMark, SkillsMark } from '../ThreadPickerMarks'

afterEach(() => cleanup())

/** The tile showing on each side of a fan, at least, in CSS pixels. */
const MIN_ROOM = 2

/**
 * How wide a tile's fan draws, from the marks' own sizes, overlaps and lean.
 * jsdom lays nothing out, so this adds up what the browser would.
 */
function fanWidth(tile: HTMLElement): number {
  const marks = [...(tile.firstElementChild as HTMLElement).children] as HTMLElement[]
  // A leaning plate's corners reach past its box by this much in all.
  const overhang = (el: HTMLElement): number => {
    const size = parseFloat(el.style.width)
    const lean = el.style.transform.match(/rotate\((-?[\d.]+)deg\)/)
    const rad = lean ? (Math.abs(Number(lean[1])) * Math.PI) / 180 : 0
    return size * (Math.cos(rad) + Math.sin(rad)) - size
  }
  const laidOut = marks.reduce(
    (w, el, i) => w + parseFloat(el.style.width) + (i === 0 ? 0 : parseFloat(el.style.marginLeft)),
    0,
  )
  const hairlines = 2
  return laidOut + overhang(marks[0]!) / 2 + overhang(marks[marks.length - 1]!) / 2 + hairlines
}

describe('ThreadPickerMarks geometry', () => {
  it.each([
    ['connectors', <ConnectorsMark slugs={['github', 'notion', 'linear']} tint="var(--violet)" />],
    ['skills', <SkillsMark tint="var(--mint)" />],
  ])('keeps the %s fan inside its tile, with tile showing on both sides', (_, mark) => {
    const { container } = render(mark)
    const tile = container.firstElementChild as HTMLElement
    const room = (parseFloat(tile.style.width) - fanWidth(tile)) / 2
    expect(room).toBeGreaterThanOrEqual(MIN_ROOM)
  })
})

describe('ThreadPickerMarks', () => {
  it('draws one logo per slug it is given', () => {
    const { container } = render(
      <ConnectorsMark slugs={['github', 'notion', 'linear']} tint="var(--violet)" />,
    )
    // ConnectorGlyph renders a single <path> per mark.
    expect(container.querySelectorAll('svg path')).toHaveLength(3)
  })

  it('never draws more than the three that fit', () => {
    const { container } = render(
      <ConnectorsMark
        slugs={['github', 'notion', 'linear', 'slack', 'figma']}
        tint="var(--violet)"
      />,
    )
    expect(container.querySelectorAll('svg path')).toHaveLength(3)
  })

  it('renders with no connectors at all rather than throwing', () => {
    // An install with nothing recognisable still has to open the picker.
    const { container } = render(<ConnectorsMark slugs={[]} tint="var(--violet)" />)
    expect(container.querySelectorAll('svg path')).toHaveLength(0)
  })

  it('draws the skill plates and the new-agent Boo', () => {
    const skills = render(<SkillsMark tint="var(--mint)" />)
    expect(skills.container.querySelectorAll('span > span > span')).toHaveLength(3)
    cleanup()
    const agent = render(<NewAgentMark tint="var(--primary)" />)
    expect(agent.container.querySelector('svg')).not.toBeNull()
  })
})
