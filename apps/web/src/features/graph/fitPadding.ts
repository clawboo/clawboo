import type { FitViewOptions } from '@xyflow/react'

// ─── Fit padding ─────────────────────────────────────────────────────────────
//
// The viewport bar floats over the canvas's bottom-right corner, and both
// graphs reach into that corner: the org chart's lower-right team in Radial,
// and a team graph's bottom row, which is stretched to its card's width. A
// symmetric fit could land a Boo there, name and all, under the bar, so every
// fit keeps the bar's band clear at the bottom.

/** The viewport bar's distance from the canvas floor (its `bottom` style). */
export const VIEWPORT_BAR_INSET = 12
/** The bar's height: a 32px button, 4px of padding and a 1px border, top and bottom. */
export const VIEWPORT_BAR_HEIGHT = 42
/** Air between the top of the bar and the lowest Boo. */
const VIEWPORT_BAR_GAP = 8
/** How far above the canvas floor a fit ends. */
export const VIEWPORT_BAR_CLEARANCE = VIEWPORT_BAR_INSET + VIEWPORT_BAR_HEIGHT + VIEWPORT_BAR_GAP

/**
 * The `padding` for a fitView on the graph.
 *
 * `padding` is React Flow's fractional padding, which it turns into
 * `(h - h / (1 + padding)) / 2` pixels a side. The fit keeps that on the top
 * and sides and makes the bottom at least the bar's clearance, or the
 * fraction's own margin when that is bigger.
 */
export function graphFitPadding(
  padding: number,
  canvasHeight: number,
): NonNullable<FitViewOptions['padding']> {
  const share = Math.floor((canvasHeight - canvasHeight / (1 + padding)) * 0.5)
  return { x: padding, top: padding, bottom: `${Math.max(share, VIEWPORT_BAR_CLEARANCE)}px` }
}
