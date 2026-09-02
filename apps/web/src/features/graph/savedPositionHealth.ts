// Is the saved position blob usable, or is it stale enough to throw away?
//
// EXTRACTED SO IT CAN BE TESTED. This decision used to live inline in a 200-line
// layout effect, where the one case it gets wrong is invisible: a spawned node
// has no saved position, which looked identical to a blob written before some
// node existed, so every spawn discarded every hand-placed position and
// re-solved the whole canvas. The node you just dropped jumped, and so did
// everything else.
//
// The fix is upstream (a spawn writes its position before the node arrives, see
// operations/spawnNode.ts), but the predicate is worth naming and pinning
// either way: it is the difference between "the canvas remembers where you put
// things" and "the canvas rearranges itself whenever you touch it".

import type { LayoutData } from './types'

/** A node the layout is responsible for placing. */
export interface PlaceableNode {
  id: string
}

export interface SavedPositionVerdict {
  /** Use the saved blob, or lay out from scratch. */
  usable: boolean
  /** Why it was rejected. `null` when usable. */
  reason: 'requested' | 'partial-coverage' | 'runaway-span' | null
}

/**
 * A layout spanning more than this is a compounding-stretch artefact from an
 * older version, not a graph anybody arranged.
 */
const SPAN_LIMIT = 4000

export function judgeSavedPositions(
  booNodes: readonly PlaceableNode[],
  savedPositions: LayoutData['positions'],
  reLayoutRequested: boolean,
): SavedPositionVerdict {
  if (reLayoutRequested) return { usable: false, reason: 'requested' }

  const covered = booNodes.filter((n) => savedPositions[n.id])
  // PARTIAL means some Boos have coordinates and the rest would pile on the
  // origin. Zero coverage is not partial: that is a first layout, which is
  // exactly what the blob-less path is for.
  if (covered.length > 0 && covered.length < booNodes.length) {
    return { usable: false, reason: 'partial-coverage' }
  }

  const points = covered.map((n) => savedPositions[n.id]!)
  if (points.length >= 2) {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    if (maxX - minX > SPAN_LIMIT || maxY - minY > SPAN_LIMIT) {
      return { usable: false, reason: 'runaway-span' }
    }
  }

  return { usable: true, reason: null }
}
