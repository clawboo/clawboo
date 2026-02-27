'use client'

import { useMemo } from 'react'
import { parseCronExpression } from './cronUtils'

interface CronExpressionHelperProps {
  expression: string
  className?: string
}

// ─── CronExpressionHelper ─────────────────────────────────────────────────────
// Inline cron expression parser — shows a human-readable description and
// validity indicator beneath the expression input.

export function CronExpressionHelper({ expression, className }: CronExpressionHelperProps) {
  const result = useMemo(() => parseCronExpression(expression), [expression])

  if (!expression.trim()) {
    return (
      <p
        className={className}
        style={{
          fontSize: 11,
          color: 'rgba(232,232,232,0.35)',
          marginTop: 4,
          fontFamily: 'var(--font-geist-mono, monospace)',
        }}
      >
        e.g. <span style={{ color: 'rgba(232,232,232,0.55)' }}>*/5 * * * *</span> = every 5 minutes
        &nbsp;·&nbsp;
        <span style={{ color: 'rgba(232,232,232,0.55)' }}>0 9 * * 1-5</span> = weekdays at 09:00
      </p>
    )
  }

  return (
    <p
      className={className}
      style={{
        fontSize: 11,
        marginTop: 4,
        fontFamily: 'var(--font-geist-mono, monospace)',
        color: result.isValid ? '#34D399' : '#E94560',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: result.isValid ? '#34D399' : '#E94560',
          flexShrink: 0,
        }}
      />
      {result.humanReadable}
    </p>
  )
}
