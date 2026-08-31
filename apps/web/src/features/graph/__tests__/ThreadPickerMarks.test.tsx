// The chooser's three marks.
//
// The property worth locking is that the connectors mark draws the REAL marks it
// was given rather than a fixed illustration, because that is the whole reason
// it replaced a lucide glyph.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ConnectorsMark, NewAgentMark, SkillsMark } from '../ThreadPickerMarks'

afterEach(() => cleanup())

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
