// Keyboard-behavior regression tests for the shared Select. These lock two bugs
// introduced when Select gained the `searchable` filter: (1) Space stopped
// committing the highlighted option, and (2) the keyboard highlight reset to the
// selected row on every parent re-render for inline-array / <option>-children
// consumers.

import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('Select menu width', () => {
  afterEach(() => vi.restoreAllMocks())

  // jsdom lays nothing out, so give the trigger a box and the menu a natural width:
  // what it takes laid out at max-content, held between its min and max widths.
  function layout({
    left = 100,
    trigger,
    natural,
  }: {
    left?: number
    trigger: number
    natural: number
  }) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'listbox') {
        const { width, minWidth, maxWidth } = this.style
        const w =
          width === 'max-content'
            ? Math.min(
                Math.max(natural, parseFloat(minWidth) || 0),
                parseFloat(maxWidth) || Infinity,
              )
            : parseFloat(width)
        return new DOMRect(0, 0, w, 120)
      }
      if (this.getAttribute('aria-haspopup') === 'listbox')
        return new DOMRect(left, 10, trigger, 26)
      return new DOMRect()
    })
  }

  function openMenu() {
    render(<Select aria-label="pick" value="b" onChange={vi.fn()} options={OPTIONS} />)
    fireEvent.click(screen.getByRole('button', { name: 'pick' }))
    return screen.getByRole('listbox')
  }

  it('grows past a compact trigger to fit its widest option and the check', () => {
    layout({ trigger: 96, natural: 131 })
    expect(openMenu().style.width).toBe('131px')
  })

  it('is never narrower than its trigger', () => {
    layout({ trigger: 203, natural: 150 })
    expect(openMenu().style.width).toBe('203px')
  })

  it('stops growing at 320px and stays inside the viewport', () => {
    layout({ left: 900, trigger: 96, natural: 480 })
    const menu = openMenu()
    expect(menu.style.width).toBe('320px')
    expect(menu.style.left).toBe(`${window.innerWidth - 8 - 320}px`)
  })
})
