import type { CSSProperties } from 'react'
import {
  Handle,
  Position,
  useConnection,
  useStore,
  type ConnectionState,
  type ReactFlowState,
} from '@xyflow/react'
import { Plus } from 'lucide-react'

import { previewColor } from '../edges/ConnectionLine'
import { minScreenScale, minScreenSize, useZoomStep } from '../useMinScreenSize'

// ─── The port and the dock ───────────────────────────────────────────────────
//
// Every Boo builds on the canvas through two handles, one on each end of a
// thread:
//
//              ╭ ─ ─ ─ ╮         THE DOCK: a thread LANDS here. Invisible until
//              ·  ( )  ·         a thread is out; then a dashed ring rises around
//             ╭─────────╮        every Boo that can take it, and turns solid when
//             │   Boo   ┝(+)     the thread is over it. The whole ring is the drop
//             ╰─────────╯        target, not a point on it.
//                     ▲
//                     └── THE PORT: a thread STARTS here. A raised disc with a
//                         plus in the claw's reach, and "Drag to connect" beside
//                         it. Both show while the pointer is on the Boo, so a
//                         canvas of idle Boos is not covered in plus signs. The
//                         port sits inside the Boo's hover area, so reaching for
//                         it keeps it up. A touch screen cannot hover, so there
//                         the port stays visible.
//
// Both stay legible when zoomed out. The canvas usually sits between 0.25 and
// 0.35, where the port's design size would draw as a 7px speck (see
// useMinScreenSize), so it keeps a floor on screen and the label draws at text
// size at any zoom.
//
// The styling lives in globals.css (`.boo-port`, `.boo-dock`) because every
// state is a class React Flow itself puts on the handle: `connectingfrom` on the
// thread's origin, `connectionindicator` on each handle the thread may end at,
// `connectingto` + `valid` on the one it is over. Reading those keeps the states
// exact without re-rendering every Boo on every pointer move.

/** The port disc's diameter at its design size, in graph units. */
const PORT_SIZE = 26
/** The smallest the port ever draws on screen, in CSS pixels. */
const PORT_MIN_SCREEN = 14
/**
 * How far the port's centre sits outside the Boo's box, in graph units: close
 * enough that the disc tucks against the claw and reads as part of the Boo.
 */
const PORT_OUTSET = 7
/** Gap between the port's rim and its label, on screen. */
const LABEL_GAP_SCREEN = 7

/** The dock's centre dot, design size and on-screen floor. */
const DOCK_DOT_SIZE = 12
const DOCK_DOT_MIN_SCREEN = 8
/** The ring's clearance around the Boo's box, in graph units. */
const DOCK_PAD = 10
/** The ring's stroke on screen, in CSS pixels. */
const DOCK_STROKE_SCREEN = 1.5

/** What a Boo needs to know about the thread in flight. Primitive, so a shallow
 *  compare keeps every Boo from re-rendering on each pointer move. */
function selectThread(c: ConnectionState): {
  dragging: boolean
  fromId: string | null
  color: string
} {
  return c.inProgress
    ? { dragging: true, fromId: c.fromNode.id, color: previewColor(c.fromNode) }
    : { dragging: false, fromId: null, color: 'var(--primary)' }
}

/** A click on a port has armed click-to-connect; the next click on a dot lands it. */
function selectClickArmed(s: ReactFlowState): boolean {
  return s.connectionClickStartHandle !== null
}

/**
 * The source handle a thread is pulled from. Hidden when the canvas is locked:
 * a lock that left the authoring affordance on screen would be saying two
 * things at once.
 *
 * `booW` is the width of whatever the port sits beside: a Boo, or a loose tile
 * waiting to be given to one. `label` is the hint, which says what the drag
 * does from there.
 */
export function BooPort({
  booW,
  isConnectable,
  label = 'Drag to connect',
}: {
  booW: number
  isConnectable: boolean
  label?: string
}) {
  const zoom = useZoomStep()
  // While a thread is out, by drag or by an armed click, a port and its hint
  // would be the wrong instruction on every Boo the pointer crosses on its way
  // to a target. The thread's own port is exempt in CSS by React Flow's
  // `connectingfrom` / `clickconnecting` classes.
  const threadOut = useConnection((c) => c.inProgress)
  const clickArmed = useStore(selectClickArmed)
  const quiet = threadOut || clickArmed
  const portScale = minScreenScale(PORT_SIZE, PORT_MIN_SCREEN, zoom)
  // The label is a hint, so it holds text size on screen like a tooltip would,
  // instead of shrinking and growing with the canvas.
  const labelScale = 1 / zoom
  const labelLeft = (PORT_SIZE / 2) * portScale + LABEL_GAP_SCREEN * labelScale

  return (
    <div
      aria-hidden
      className="boo-port-anchor"
      style={{
        // A 0x0 point at the port's centre; everything below is placed and
        // scaled around it, so the handle's centre never moves.
        position: 'absolute',
        left: booW + PORT_OUTSET,
        top: '50%',
        width: 0,
        height: 0,
        visibility: isConnectable ? undefined : 'hidden',
      }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, transform: `scale(${portScale})` }}>
        <Handle
          type="source"
          id="right"
          position={Position.Right}
          isConnectable={isConnectable}
          className={`boo-port${quiet ? ' boo-port--quiet' : ''}`}
          style={{
            // Centred on the anchor, replacing React Flow's edge-hugging
            // `right: 0; translate(50%, -50%)`.
            left: 0,
            top: 0,
            right: 'auto',
            transform: 'translate(-50%, -50%)',
            width: PORT_SIZE,
            height: PORT_SIZE,
          }}
        >
          <Plus size={14} strokeWidth={2.75} aria-hidden className="boo-port__glyph" />
        </Handle>
      </div>
      <div
        className={`boo-port__label${quiet ? ' boo-port__label--quiet' : ''}`}
        style={{
          position: 'absolute',
          left: labelLeft,
          top: 0,
          transform: `translateY(-50%) scale(${labelScale})`,
          transformOrigin: '0 50%',
        }}
      >
        <span className="boo-port__label-inner">{label}</span>
      </div>
    </div>
  )
}

/**
 * The target handle a thread lands on. `agentNodeId` is this Boo's node id, so
 * a thread pulled from this Boo does not offer to land back on it: that route
 * is always refused, and a ring inviting the drop would promise otherwise.
 */
export function BooDock({
  agentNodeId,
  booW,
  booH,
  isConnectable,
}: {
  agentNodeId: string
  booW: number
  booH: number
  isConnectable: boolean
}) {
  const zoom = useZoomStep()
  const thread = useConnection(selectThread)
  const ownThread = thread.fromId === agentNodeId
  const dot = minScreenSize(DOCK_DOT_SIZE, DOCK_DOT_MIN_SCREEN, zoom)

  return (
    <Handle
      type="target"
      id="dock"
      position={Position.Top}
      isConnectable={isConnectable}
      // A dock only receives. Starting a thread here would draw it backwards.
      isConnectableStart={false}
      isConnectableEnd={!ownThread}
      className={`boo-dock${thread.dragging ? ' boo-dock--drag' : ''}`}
      style={
        {
          // The dot rides the top of the ring. React Flow keeps its own
          // `left: 50%; translate(-50%, -50%)`, so this only lifts it.
          top: -DOCK_PAD,
          width: dot,
          height: dot,
          '--thread': thread.color,
          '--dock-w': `${booW + DOCK_PAD * 2}px`,
          '--dock-h': `${booH + DOCK_PAD * 2}px`,
          // From the dot's centre down to the Boo's.
          '--dock-dy': `${booH / 2 + DOCK_PAD}px`,
          '--dock-stroke': `${DOCK_STROKE_SCREEN / zoom}px`,
        } as CSSProperties
      }
    />
  )
}
