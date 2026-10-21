// Which column a dragged card is over. Columns are large targets, so a pointer
// drag goes where the pointer is and nowhere else. dnd-kit hands this only the
// columns that would take the card, so a pointer over a refused column, over
// Needs you or over the day gutter finds nothing, and letting go there sends the
// card back. Falling back to whatever the lifted card overlaps would move it
// into a neighbour the pointer was not on.
//
// A keyboard drag has no pointer, so it is matched by the lifted card's overlap.

import { pointerWithin, rectIntersection, type CollisionDetection } from '@dnd-kit/core'

export const boardCollision: CollisionDetection = (args) => {
  if (args.pointerCoordinates) return pointerWithin(args)
  return rectIntersection(args)
}
