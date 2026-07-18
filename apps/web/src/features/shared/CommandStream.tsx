// The shared terminal-style log box — the store-free, line-capped, RAF-scroll
// variant extracted from RuntimeConnectionCard's install log (the same
// `var(--terminal-bg, #0d1117)` box InstallStep + OpenClawInlineSetup also
// hand-roll). Always dark regardless of theme: log output reads as a terminal.
//
// Pair with the `useCommandLog` hook for the 200-line-capped append pattern.

import { useCallback, useRef, useState } from 'react'
import { Terminal } from 'lucide-react'

const MAX_LINES = 200

export interface CommandLog {
  lines: string[]
  append: (line?: string) => void
  clear: () => void
  /** Attach to the CommandStream so appends auto-scroll. */
  endRef: React.RefObject<HTMLDivElement | null>
}

export function useCommandLog(): CommandLog {
  const [lines, setLines] = useState<string[]>([])
  const endRef = useRef<HTMLDivElement | null>(null)
  const append = useCallback((line?: string) => {
    if (!line) return
    setLines((prev) => [...prev, line].slice(-MAX_LINES))
    // Optional-call: jsdom has no scrollIntoView.
    requestAnimationFrame(() => endRef.current?.scrollIntoView?.({ block: 'end' }))
  }, [])
  const clear = useCallback(() => setLines([]), [])
  return { lines, append, clear, endRef }
}

export function CommandStream({
  log,
  placeholder = 'Working…',
  maxHeight = 160,
  testId,
}: {
  log: CommandLog
  placeholder?: string
  maxHeight?: number
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      className="overflow-y-auto rounded-lg p-2.5"
      style={{ maxHeight, background: 'var(--terminal-bg, #0d1117)' }}
    >
      {log.lines.length === 0 ? (
        <div
          className="flex items-center gap-1.5 font-mono text-[11px]"
          style={{ color: 'rgb(201 209 217 / 0.7)' }}
        >
          <Terminal size={11} /> {placeholder}
        </div>
      ) : (
        log.lines.map((line, i) => (
          <div
            key={i}
            className="font-mono text-[11px] leading-relaxed"
            style={{ color: 'rgb(201 209 217 / 0.7)' }}
          >
            {line}
          </div>
        ))
      )}
      <div ref={log.endRef} />
    </div>
  )
}
