// Screen-reader announcements for the board's drag-and-drop, replacing dnd-kit's
// `defaultAnnouncements` — which read raw ids ("Picked up draggable item
// 9f3c8a1e-…", "…was moved over droppable area in_progress").
//
// Deliberately PURE and dependency-free: every callback derives what it needs
// from the drag event itself, via the payload the grip handle puts on
// `useDraggable({ data })`. That is not an optimization, it is a correctness
// requirement. `BoardPanel.onDragEnd` calls `setActiveTask(null)` BEFORE it
// resolves the drop, and dnd-kit dispatches announcements through `useDndMonitor`
// in the same batched update as the `onDragEnd` prop — so a closure over
// `activeTask` reads null, and one over `effectiveTasks` reads a snapshot that
// may already have an optimistic override queued. Reading the drag payload
// sidesteps both, and lets this whole module be unit-tested in the node vitest
// project with no DOM and no React.

import type { Announcements, ScreenReaderInstructions } from '@dnd-kit/core'

import { canTransition, statusLabel } from './boardStatus'

/** The one droppable id on the board that is NOT a status string. A task whose
 *  status falls outside the canonical 7 lands here instead of being silently
 *  dropped, and `statusLabel` would pass the raw sentinel straight through.
 *  Owned here (and imported by BoardPanel) so the column and its spoken label
 *  cannot drift apart. */
export const OTHER_COLUMN = { id: '__other__', label: 'Other' } as const

/** Spoken label for any board droppable id. */
export function columnLabel(columnId: string): string {
  // Defensive: a draggable that somehow carries no payload. Reads naturally in
  // every sentence below ("stays in its column").
  if (!columnId) return 'its column'
  return columnId === OTHER_COLUMN.id ? OTHER_COLUMN.label : statusLabel(columnId)
}

/** The payload `DraggableCard` attaches to `useDraggable({ data })`. */
export interface BoardDragData {
  /** The card's status at pickup. Board column droppable ids ARE statuses, so
   *  this doubles as the source column id. Captured at pickup on purpose: if the
   *  5 s poll lands mid-drag, the user should still hear the column they were
   *  told they picked the card up from. */
  fromStatus: string
  /** Display title, already defaulted — `BoardTask.title` is optional. */
  title: string
}

function dragData(active: { data: { current?: Record<string, unknown> } }): BoardDragData {
  const d = active.data.current
  return {
    fromStatus: typeof d?.fromStatus === 'string' ? d.fromStatus : '',
    title: typeof d?.title === 'string' ? d.title : 'this task',
  }
}

/**
 * A module-level constant on purpose: dnd-kit's `<Accessibility>` re-registers
 * its `useDndMonitor` listener whenever the announcements object's identity
 * changes, and a constant can never churn (no `useMemo`, no deps array to get
 * wrong).
 */
export const boardAnnouncements: Announcements = {
  onDragStart({ active }) {
    const { title, fromStatus } = dragData(active)
    // Movement instructions live in `screenReaderInstructions` below (read from
    // the handle's aria-describedby, i.e. only on the keyboard path) rather than
    // here, which also fires for pointer drags.
    return `Picked up “${title}” from ${columnLabel(fromStatus)}.`
  },

  onDragOver({ active, over }) {
    const { title, fromStatus } = dragData(active)
    // `over` is null for BOTH dead space and an illegal column: mid-drag,
    // `columnDropDisabled` turns illegal columns off as droppables, so they
    // report no hit rather than an illegal target. One sentence has to cover
    // both, so it names the consequence instead of guessing the cause.
    if (!over) {
      return `“${title}” is not over a column that can accept it. Release to leave it in ${columnLabel(fromStatus)}.`
    }
    const to = String(over.id)
    if (to === fromStatus) return `Over ${columnLabel(to)}, where “${title}” already is.`
    // Reachable in a narrow race: `columnDropDisabled` depends on the
    // `activeTask` state set in onDragStart, so a fast pointer move between the
    // dispatch and the re-render can still hit an illegal column (or `Other`).
    if (!canTransition(fromStatus, to)) {
      return `Over ${columnLabel(to)}. It can’t accept “${title}”.`
    }
    return `Over ${columnLabel(to)}. Release to move “${title}” from ${columnLabel(fromStatus)} to ${columnLabel(to)}.`
  },

  onDragEnd({ active, over }) {
    const { title, fromStatus } = dragData(active)
    if (!over) {
      return `Dropped “${title}” outside the columns. It stays in ${columnLabel(fromStatus)}.`
    }
    const to = String(over.id)
    if (to === fromStatus) return `Dropped “${title}” back in ${columnLabel(to)}. Nothing changed.`
    if (!canTransition(fromStatus, to)) {
      return `Dropped “${title}” on ${columnLabel(to)}, which can’t accept it. It stays in ${columnLabel(fromStatus)}.`
    }
    // HONESTY CONSTRAINT: this fires at drop time, before `useStatusMutation`
    // runs — which may still open a confirm dialog ("Unassign the agent?" on a
    // → To do move, "Complete anyway?" on a gated → Done) and may roll the move
    // back. So it announces the REQUEST, never the outcome. The outcome arrives
    // on the toast, which ToastContainer now puts in a live region.
    return `Dropped “${title}” on ${columnLabel(to)}. Saving the move from ${columnLabel(fromStatus)} to ${columnLabel(to)}.`
  },

  onDragCancel({ active }) {
    const { title, fromStatus } = dragData(active)
    return `Cancelled. “${title}” stays in ${columnLabel(fromStatus)}.`
  },
}

/** Read from the grip handle's `aria-describedby` (dnd-kit wires that up in
 *  `useDraggable`'s `attributes`), so it reaches the user exactly when it is
 *  actionable: while the handle is focused, before the pickup. */
export const boardScreenReaderInstructions: ScreenReaderInstructions = {
  draggable:
    'Press space bar to pick up this task. Use the arrow keys to move it between columns, ' +
    'space bar again to drop it, or escape to cancel. Columns this task can’t legally move ' +
    'to won’t accept it.',
}

/** Hoisted so the `accessibility` prop object identity is stable too. */
export const BOARD_ACCESSIBILITY = {
  announcements: boardAnnouncements,
  screenReaderInstructions: boardScreenReaderInstructions,
} as const
