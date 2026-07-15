// Keyboard-behavior regression tests for the shared Select. These lock two bugs
// introduced when Select gained the `searchable` filter: (1) Space stopped
// committing the highlighted option, and (2) the keyboard highlight reset to the
// selected row on every parent re-render for inline-array / <option>-children
// consumers.

import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { Select } from '../Select'

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
]

describe('Select keyboard behavior', () => {
  it('Space commits the highlighted option (non-searchable)', () => {
    const onChange = vi.fn()
    render(<Select aria-label="pick" value="a" onChange={onChange} options={OPTIONS} />)
    const trigger = screen.getByRole('button', { name: 'pick' })
    fireEvent.click(trigger) // open (highlight = selected 'a')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // highlight -> 'b'
    fireEvent.keyDown(trigger, { key: ' ' }) // Space commits
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('Enter commits the highlighted option', () => {
    const onChange = vi.fn()
    render(<Select aria-label="pick" value="a" onChange={onChange} options={OPTIONS} />)
    const trigger = screen.getByRole('button', { name: 'pick' })
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // highlight -> 'c'
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('keeps the keyboard highlight across a parent re-render (children-based options)', () => {
    const onChange = vi.fn()
    // `<option>` children are re-parsed into a NEW array each render — the case that
    // used to reset the highlight back to the selected row on every re-render.
    function Harness({ tick }: { tick: number }) {
      return (
        <div data-tick={tick}>
          <Select aria-label="pick" value="a" onChange={onChange}>
            <option value="a">Alpha</option>
            <option value="b">Beta</option>
            <option value="c">Gamma</option>
          </Select>
        </div>
      )
    }
    const { rerender } = render(<Harness tick={0} />)
    const trigger = screen.getByRole('button', { name: 'pick' })
    fireEvent.click(trigger)
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // highlight -> 'b'
    rerender(<Harness tick={1} />) // parent re-render (fresh <option> array)
    fireEvent.keyDown(trigger, { key: 'Enter' }) // commit the STILL-highlighted 'b'
    expect(onChange).toHaveBeenCalledWith('b')
  })
})
