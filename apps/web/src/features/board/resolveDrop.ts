// Pure drag-resolution logic for the board, extracted so it's exhaustively
// unit-testable without a DOM (dnd-kit's real drag needs layout/pointer events
// that jsdom doesn't implement). Given the dragged card's task id and the
// droppable it was released over, decide the intended status move — or `null`
// for a no-op. Legality of the move (state machine) and the agent-release gate
// are enforced downstream in `useStatusMutation`, exactly as the drawer editor.

import type { BoardTask } from '@/lib/boardClient'

export interface DropResolution {
  taskId: string
  from: string
  to: string
}

/**
 * @param activeId  the dragged card's task id (the `useDraggable` id).
 * @param overId    the droppable released over, or `null` if dropped in dead space.
 *                  Board column droppable ids ARE the status strings (e.g. `todo`),
 *                  so `overId` is the target status directly.
 * @param tasks     the current tasks (statuses should already reflect any optimistic
 *                  overrides, so a second drag mid-flight resolves from the live column).
 * @returns the intended move, or `null` for: dropped outside a column, an unknown
 *          task, or a drop back onto the card's own column (no change).
 */
export function resolveDrop(
  activeId: string,
  overId: string | null,
  tasks: BoardTask[],
): DropResolution | null {
  if (!overId) return null
  const task = tasks.find((t) => t.id === activeId)
  if (!task) return null
  if (overId === task.status) return null
  return { taskId: activeId, from: task.status, to: overId }
}
