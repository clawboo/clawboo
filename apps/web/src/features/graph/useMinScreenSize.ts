import { useStore, type ReactFlowState } from '@xyflow/react'

// ─── Sizes with a floor on screen ────────────────────────────────────────────
//
// Everything inside the React Flow viewport is scaled by the zoom, and the zoom
// this canvas actually sits at is LOW: Atlas fits a fleet at roughly 0.25 and a
// team graph in its group chat at roughly 0.3. At those levels a 1.5px edge
// draws at 0.4px and a 20px control at 5px: a hairline and a speck.
//
// `max(size, floor / zoom)` draws a thing at its designed size wherever that is
// already legible and stops it shrinking below `floor` screen pixels anywhere
// else. Above the floor it scales with the canvas exactly as before.

/** The smallest zoom the math trusts. Both canvases clamp well above it. */
const MIN_ZOOM = 0.05

/**
 * The viewport zoom, rounded to 2.5% steps.
 *
 * A pinch or a wheel spin changes the zoom on every frame. Subscribing to the
 * step instead of the raw value re-renders a subscriber only when the zoom
 * crosses a step, and a 2.5% change in a size this small is not visible.
 */
export function selectZoomStep(s: ReactFlowState): number {
  return Math.round(s.transform[2] * 40) / 40
}

/** Graph-space size that draws at `graphPx * zoom`, but never below `minScreenPx`. */
export function minScreenSize(graphPx: number, minScreenPx: number, zoom: number): number {
  return Math.max(graphPx, minScreenPx / Math.max(zoom, MIN_ZOOM))
}

/**
 * Factor that scales something designed at `graphPx` up to its on-screen floor,
 * or 1 when it is already at least that big. For a composite drawn at its
 * design size (a control with a glyph and a border) and scaled as one piece.
 */
export function minScreenScale(graphPx: number, minScreenPx: number, zoom: number): number {
  return minScreenSize(graphPx, minScreenPx, zoom) / graphPx
}

/** The current zoom step. Must be called inside a React Flow provider. */
export function useZoomStep(): number {
  return useStore(selectZoomStep)
}
