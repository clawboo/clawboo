// A number that rolls when it changes: the old value slides out and the new one
// slides in, upward for more and downward for less, so a count that an agent
// changed reads as a change rather than a glitch. The first render shows the
// number as it is, and so does a change made while `quiet` (a new range or a
// new filter, where every number changes at once).
//
// Never put one inside a live region: its outgoing copy is in the DOM for the
// length of the roll. The outgoing copy is hidden from screen readers.

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

interface Roll {
  from: number
  dir: 'up' | 'down'
  n: number
}

const ROLL_MS = 200

export function RollingCount({
  value,
  quiet = false,
  className,
  style,
}: {
  value: number
  /** Show a change without rolling it. */
  quiet?: boolean
  className?: string
  style?: CSSProperties
}) {
  const shown = useRef(value)
  const count = useRef(0)
  const [roll, setRoll] = useState<Roll | null>(null)

  // Before paint, so the new number never shows unmoved for a frame.
  useLayoutEffect(() => {
    const from = shown.current
    shown.current = value
    if (from === value || quiet) return
    count.current += 1
    setRoll({ from, dir: value > from ? 'up' : 'down', n: count.current })
  }, [value, quiet])

  useLayoutEffect(() => {
    if (!roll) return
    const t = setTimeout(() => setRoll(null), ROLL_MS)
    return () => clearTimeout(t)
  }, [roll])

  return (
    <span className={['board-roll', className].filter(Boolean).join(' ')} style={style}>
      <span key={roll?.n ?? 0} className={roll ? `board-roll-in-${roll.dir}` : undefined}>
        {value}
      </span>
      {roll ? (
        <span aria-hidden className={`board-roll-out-${roll.dir}`}>
          {roll.from}
        </span>
      ) : null}
    </span>
  )
}
