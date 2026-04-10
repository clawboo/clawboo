import { useRef, useCallback } from 'react'
import { Separator } from 'react-resizable-panels'

export function ResizeHandle({ direction }: { direction: 'horizontal' | 'vertical' }) {
  const isHorizontal = direction === 'horizontal'
  const ref = useRef<HTMLDivElement>(null)

  const onMouseEnter = useCallback(() => {
    if (ref.current) ref.current.style.background = 'rgba(233,69,96,0.4)'
  }, [])

  const onMouseLeave = useCallback(() => {
    if (ref.current) ref.current.style.background = 'transparent'
  }, [])

  return (
    <Separator
      className="resize-handle"
      elementRef={ref}
      style={{
        width: isHorizontal ? 3 : '100%',
        height: isHorizontal ? '100%' : 3,
        background: 'transparent',
        position: 'relative',
        flexShrink: 0,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        transition: 'background 0.15s',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        style={{
          position: 'absolute',
          [isHorizontal ? 'left' : 'top']: 1,
          [isHorizontal ? 'top' : 'left']: 0,
          [isHorizontal ? 'bottom' : 'right']: 0,
          [isHorizontal ? 'width' : 'height']: 1,
          background: 'rgba(255,255,255,0.06)',
        }}
      />
    </Separator>
  )
}
