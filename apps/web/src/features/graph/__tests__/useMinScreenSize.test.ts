import { describe, expect, it } from 'vitest'
import type { ReactFlowState } from '@xyflow/react'

import { minScreenScale, minScreenSize, selectZoomStep } from '../useMinScreenSize'

// The floor exists for the zoom this canvas actually sits at. Atlas fits a fleet
// at roughly 0.25 and a team graph at roughly 0.3; at those levels a design size
// alone draws as a hairline edge and a speck of a port.

describe('minScreenSize', () => {
  it('keeps the design size wherever it is already legible', () => {
    // 2px at zoom 1 draws at 2px, above a 1.4px floor: nothing changes.
    expect(minScreenSize(2, 1.4, 1)).toBe(2)
    // Zooming IN never inflates anything past its design size.
    expect(minScreenSize(2, 1.4, 2.5)).toBe(2)
  })

  it('holds the floor on screen when zoomed out', () => {
    // At Atlas's usual 0.25, a 2px edge would draw at 0.5px.
    const size = minScreenSize(2, 1.4, 0.25)
    expect(size * 0.25).toBeCloseTo(1.4)
    expect(size).toBeGreaterThan(2)
  })

  it('never divides by a zero zoom', () => {
    expect(Number.isFinite(minScreenSize(2, 1.4, 0))).toBe(true)
  })
})

describe('minScreenScale', () => {
  it('is 1 at a legible zoom and scales a composite up to its floor below it', () => {
    expect(minScreenScale(26, 14, 1)).toBe(1)
    // 26 * 0.3 = 7.8px on screen, below a 14px floor: scale the whole control.
    expect(26 * minScreenScale(26, 14, 0.3) * 0.3).toBeCloseTo(14)
  })
})

describe('selectZoomStep', () => {
  const state = (zoom: number) => ({ transform: [0, 0, zoom] }) as unknown as ReactFlowState

  it('rounds the zoom to 2.5% steps so a pinch does not re-render every frame', () => {
    expect(selectZoomStep(state(0.26))).toBe(0.25)
    expect(selectZoomStep(state(0.27))).toBe(0.275)
    expect(selectZoomStep(state(1))).toBe(1)
  })
})
