// CollapsiblePillRow — shows popular options inline + folds the rest under a
// "+N more" toggle, keeping the active option visible even when collapsed.

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CollapsiblePillRow, type PillOption } from '../CollapsiblePillRow'

const OPTIONS: PillOption[] = Array.from({ length: 10 }, (_, i) => ({
  key: `d${i}`,
  label: `Domain ${i}`,
}))

afterEach(() => cleanup())

const row = () => screen.getByRole('group', { name: 'test row' })
const labels = () =>
  within(row())
    .getAllByRole('button')
    .map((b) => b.textContent?.trim())

describe('CollapsiblePillRow', () => {
  it('collapses to All + primaryCount options + a "+N more" toggle', () => {
    render(
      <CollapsiblePillRow
        aria-label="test row"
        options={OPTIONS}
        activeKey="all"
        onSelect={() => {}}
        primaryCount={4}
      />,
    )
    // All + 4 inline + "+6 more"  (the 5 hidden options are not rendered)
    expect(labels()).toEqual(['All', 'Domain 0', 'Domain 1', 'Domain 2', 'Domain 3', '+6 more'])
    expect(screen.queryByRole('button', { name: 'Domain 7' })).not.toBeInTheDocument()
  })

  it('expands to every option + a "Show less" toggle when More is clicked', async () => {
    const user = userEvent.setup()
    render(
      <CollapsiblePillRow
        aria-label="test row"
        options={OPTIONS}
        activeKey="all"
        onSelect={() => {}}
        primaryCount={4}
      />,
    )
    await user.click(screen.getByRole('button', { name: '+6 more' }))
    const l = labels()
    expect(l).toContain('Domain 9')
    expect(l).toContain('Show less')
    expect(l).not.toContain('+6 more')
    // All + 10 options + Show less
    expect(l).toHaveLength(12)
  })

  it('keeps the active option visible while collapsed even if it is in the hidden tail', () => {
    render(
      <CollapsiblePillRow
        aria-label="test row"
        options={OPTIONS}
        activeKey="d8" // hidden (beyond primaryCount)
        onSelect={() => {}}
        primaryCount={4}
      />,
    )
    const l = labels()
    expect(l).toContain('Domain 8') // active tail option pinned visible
    // 4 primary + the pinned active = 5 visible, so 5 of 10 remain hidden.
    expect(l).toContain('+5 more')
    expect(screen.getByRole('button', { name: 'Domain 8' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onSelect with "all" or the option key', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <CollapsiblePillRow
        aria-label="test row"
        options={OPTIONS}
        activeKey="all"
        onSelect={onSelect}
        primaryCount={4}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Domain 2' }))
    expect(onSelect).toHaveBeenCalledWith('d2')
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(onSelect).toHaveBeenCalledWith('all')
  })

  it('renders no toggle when options fit within primaryCount', () => {
    render(
      <CollapsiblePillRow
        aria-label="test row"
        options={OPTIONS.slice(0, 3)}
        activeKey="all"
        onSelect={() => {}}
        primaryCount={7}
      />,
    )
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument()
    expect(labels()).toEqual(['All', 'Domain 0', 'Domain 1', 'Domain 2'])
  })
})
