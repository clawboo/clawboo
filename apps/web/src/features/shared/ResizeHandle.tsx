import { useRef, useCallback, type CSSProperties } from 'react'
import { Separator } from 'react-resizable-panels'

// Visual seam between two resizable panels. Two design ideas stacked:
//   A. Inset-shadow groove — a 1px dark line on one side of the handle and a
//      1px highlight line on the other. The panel "above" appears to end on a
//      shadow edge, the panel "below" starts on a lit edge, giving the seam
//      perceived depth.
//   B. Drag-grip — a small cluster of dots centered on the seam, telling the
//      user the divider is draggable. Always visible but dim; brightens on
//      hover/active drag.
//
// Hover behaviour: the resting groove stays, and the gap between the two lines
// fills with the accent red so the seam reads as "lit up" rather than "just a
// different colored bar."

const SHADOW_COLOR = 'rgba(0,0,0,0.55)'
const HIGHLIGHT_COLOR = 'rgba(255,255,255,0.06)'
const GRIP_COLOR = 'rgba(232,232,232,0.32)'
const GRIP_COLOR_HOVER = 'rgba(232,232,232,0.7)'
const ACCENT_FILL = 'rgba(233,69,96,0.35)'
const HANDLE_THICKNESS = 5

export function ResizeHandle({ direction }: { direction: 'horizontal' | 'vertical' }) {
  const isHorizontal = direction === 'horizontal'
  const ref = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const gripDotsRef = useRef<HTMLDivElement>(null)

  const setGripColor = useCallback((color: string) => {
    if (!gripDotsRef.current) return
    for (const dot of Array.from(gripDotsRef.current.children) as HTMLElement[]) {
      dot.style.background = color
    }
  }, [])

  const onMouseEnter = useCallback(() => {
    if (fillRef.current) fillRef.current.style.background = ACCENT_FILL
    setGripColor(GRIP_COLOR_HOVER)
  }, [setGripColor])

  const onMouseLeave = useCallback(() => {
    if (fillRef.current) fillRef.current.style.background = 'transparent'
    setGripColor(GRIP_COLOR)
  }, [setGripColor])

  // Position lookups — keeps the JSX readable instead of inline ternaries.
  const shadowLine: CSSProperties = isHorizontal
    ? { left: 0, top: 0, bottom: 0, width: 1 }
    : { top: 0, left: 0, right: 0, height: 1 }
  const highlightLine: CSSProperties = isHorizontal
    ? { right: 0, top: 0, bottom: 0, width: 1 }
    : { bottom: 0, left: 0, right: 0, height: 1 }
  const fillInset: CSSProperties = isHorizontal
    ? { left: 1, right: 1, top: 0, bottom: 0 }
    : { top: 1, bottom: 1, left: 0, right: 0 }

  return (
    <Separator
      className="resize-handle"
      elementRef={ref}
      style={{
        width: isHorizontal ? HANDLE_THICKNESS : '100%',
        height: isHorizontal ? '100%' : HANDLE_THICKNESS,
        background: 'transparent',
        position: 'relative',
        flexShrink: 0,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* (A) Shadow line — top / left edge */}
      <div style={{ position: 'absolute', background: SHADOW_COLOR, ...shadowLine }} />

      {/* (A) Hover accent fill — sits between the two lines, transparent at rest */}
      <div
        ref={fillRef}
        style={{
          position: 'absolute',
          background: 'transparent',
          transition: 'background 0.15s',
          ...fillInset,
        }}
      />

      {/* (A) Highlight line — bottom / right edge */}
      <div style={{ position: 'absolute', background: HIGHLIGHT_COLOR, ...highlightLine }} />

      {/* (B) Drag-grip dots — 3 dots, centered on the seam */}
      <div
        ref={gripDotsRef}
        aria-hidden
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          flexDirection: isHorizontal ? 'column' : 'row',
          gap: 3,
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            width: 2,
            height: 2,
            borderRadius: '50%',
            background: GRIP_COLOR,
            transition: 'background 0.15s',
          }}
        />
        <span
          style={{
            width: 2,
            height: 2,
            borderRadius: '50%',
            background: GRIP_COLOR,
            transition: 'background 0.15s',
          }}
        />
        <span
          style={{
            width: 2,
            height: 2,
            borderRadius: '50%',
            background: GRIP_COLOR,
            transition: 'background 0.15s',
          }}
        />
      </div>
    </Separator>
  )
}
