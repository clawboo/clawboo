import { createLucideIcon } from 'lucide-react'

// ─── Atlas layout icons ──────────────────────────────────────────────────────
//
// Pictures of the two layouts the Atlas mode switch picks between, drawn on
// Lucide's 24px grid with its 2px round-capped stroke so they sit beside the
// library's icons without looking borrowed. Lucide has nothing that shows
// either shape. Nodes are circles because the Boos they stand for are round.

/** Top-down: Boo Zero above, teams in a row beneath it. */
export const TreeLayoutIcon = createLucideIcon('TreeLayout', [
  ['circle', { cx: '12', cy: '4.5', r: '2.5', key: 'root' }],
  ['path', { d: 'M12 7v4', key: 'trunk' }],
  ['path', { d: 'M5 17v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4', key: 'bar' }],
  ['path', { d: 'M12 11v6', key: 'mid' }],
  ['circle', { cx: '5', cy: '19', r: '2', key: 'left' }],
  ['circle', { cx: '12', cy: '19', r: '2', key: 'middle' }],
  ['circle', { cx: '19', cy: '19', r: '2', key: 'right' }],
])

/**
 * Radial: Boo Zero at the centre, teams as petals around it. Five petals on a
 * radius of 8.5, spokes running from the hub's rim to each petal's rim.
 */
export const RadialLayoutIcon = createLucideIcon('RadialLayout', [
  ['circle', { cx: '12', cy: '12', r: '2.5', key: 'hub' }],
  ['circle', { cx: '12', cy: '3.5', r: '2', key: 'p0' }],
  ['circle', { cx: '20.08', cy: '9.37', r: '2', key: 'p1' }],
  ['circle', { cx: '17', cy: '18.88', r: '2', key: 'p2' }],
  ['circle', { cx: '7', cy: '18.88', r: '2', key: 'p3' }],
  ['circle', { cx: '3.92', cy: '9.37', r: '2', key: 'p4' }],
  ['path', { d: 'M12 9.5V5.5', key: 's0' }],
  ['path', { d: 'M14.38 11.23l3.8-1.24', key: 's1' }],
  ['path', { d: 'M13.47 14.02l2.35 3.24', key: 's2' }],
  ['path', { d: 'M10.53 14.02l-2.35 3.24', key: 's3' }],
  ['path', { d: 'M9.62 11.23l-3.8-1.24', key: 's4' }],
])
