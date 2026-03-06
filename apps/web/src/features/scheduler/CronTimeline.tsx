'use client'

import { useState, useEffect, useMemo } from 'react'
import type { CronJob } from '@/stores/scheduler'
import { formatRelativeTime } from './cronUtils'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stable color per agent from a small palette. */
const AGENT_COLORS = ['#34D399', '#E94560', '#FBBF24', '#60A5FA', '#A78BFA', '#F472B6']

function agentColor(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = Math.imul(hash ^ agentId.charCodeAt(i), 0x5bd1e995)
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]!
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TimelineDot {
  key: string
  x: number // percent 0–100
  y: number // pixel offset from axis center
  color: string
  pulse: boolean
  label: string
}

interface CronTimelineProps {
  jobs: CronJob[]
  timeWindowHours?: number
}

// ─── Vertical stacking ───────────────────────────────────────────────────────
// When dots are within OVERLAP_THRESHOLD_PCT of each other on the X axis,
// offset them vertically so they don't overlap.

const OVERLAP_THRESHOLD_PCT = 3 // dots closer than 3% are considered overlapping
const DOT_SIZE = 8
const VERTICAL_STEP = DOT_SIZE + 4 // 12px between stacked dot centers
const AXIS_Y = 34 // vertical center of the axis line

function assignVerticalOffsets(dots: Omit<TimelineDot, 'y'>[]): TimelineDot[] {
  // Sort by x so we can detect clusters
  const sorted = [...dots].sort((a, b) => a.x - b.x)
  const result: TimelineDot[] = []

  let clusterStart = 0
  for (let i = 0; i <= sorted.length; i++) {
    // End of array or gap large enough to break the cluster
    const gap =
      i < sorted.length ? sorted[i]!.x - sorted[clusterStart]!.x : OVERLAP_THRESHOLD_PCT + 1

    if (gap > OVERLAP_THRESHOLD_PCT || i === sorted.length) {
      // Lay out the cluster [clusterStart, i)
      const clusterSize = i - clusterStart
      for (let j = clusterStart; j < i; j++) {
        // Center the cluster vertically around the axis
        const indexInCluster = j - clusterStart
        const offset = (indexInCluster - (clusterSize - 1) / 2) * VERTICAL_STEP
        result.push({ ...sorted[j]!, y: AXIS_Y + offset })
      }
      clusterStart = i
    }
  }

  return result
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CronTimeline({ jobs, timeWindowHours = 48 }: CronTimelineProps) {
  // Tick every 30s so relative times stay fresh
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const halfWindow = (timeWindowHours / 2) * 3_600_000
  const windowStart = now - halfWindow
  const windowEnd = now + halfWindow
  const windowMs = windowEnd - windowStart

  // Build a stable key from job IDs so React can diff properly on delete
  const jobKey = jobs.map((j) => j.id).join(',')

  const dots = useMemo(() => {
    const raw: Omit<TimelineDot, 'y'>[] = []

    for (const job of jobs) {
      // Skip inactive jobs — no dots on timeline when toggled off
      if (!job.active) continue
      const color = agentColor(job.agentId)

      // Past dot (last execution)
      if (job.lastExecution !== null && job.lastExecution >= windowStart) {
        const x = ((job.lastExecution - windowStart) / windowMs) * 100
        const rel = formatRelativeTime(new Date(job.lastExecution), new Date(now))
        raw.push({
          key: `${job.id}-last`,
          x,
          color: '#34D399',
          pulse: false,
          label: `${job.agentName} — ${job.name} — ${rel}`,
        })
      }

      // Future dot (next execution)
      if (job.nextExecution !== null && job.nextExecution <= windowEnd) {
        const x = ((job.nextExecution - windowStart) / windowMs) * 100
        const rel = formatRelativeTime(new Date(job.nextExecution), new Date(now))
        raw.push({
          key: `${job.id}-next`,
          x,
          color,
          pulse: true,
          label: `${job.agentName} — ${job.name} — ${rel}`,
        })
      }
    }

    return assignVerticalOffsets(raw)
  }, [jobKey, now, windowStart, windowEnd, windowMs])

  // Time labels positioned along the axis
  const timeLabels = [
    { pct: 0, text: `-${timeWindowHours / 2}h` },
    { pct: 25, text: `-${timeWindowHours / 4}h` },
    { pct: 50, text: 'Now' },
    { pct: 75, text: `+${timeWindowHours / 4}h` },
    { pct: 100, text: `+${timeWindowHours / 2}h` },
  ]

  return (
    <div
      style={{
        position: 'relative',
        height: 80,
        width: '100%',
        background: '#111827',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}
    >
      {/* Horizontal axis line */}
      <div
        style={{
          position: 'absolute',
          top: AXIS_Y,
          left: 0,
          right: 0,
          height: 1,
          background: 'rgba(255,255,255,0.06)',
        }}
      />

      {/* "Now" center line — dashed via repeating gradient */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          bottom: 20,
          left: '50%',
          width: 2,
          borderRadius: 1,
          opacity: 0.7,
          background:
            'repeating-linear-gradient(to bottom, #E94560 0px, #E94560 4px, transparent 4px, transparent 8px)',
        }}
      />

      {/* Time labels */}
      {timeLabels.map(({ pct, text }) => (
        <div
          key={pct}
          style={{
            position: 'absolute',
            bottom: 4,
            left: `${pct}%`,
            transform: 'translateX(-50%)',
            fontSize: 9,
            color: text === 'Now' ? '#E94560' : 'rgba(232,232,232,0.3)',
            fontFamily: 'var(--font-geist-mono, monospace)',
            fontWeight: text === 'Now' ? 600 : 400,
            whiteSpace: 'nowrap',
          }}
        >
          {text}
        </div>
      ))}

      {/* Dots */}
      {dots.map((dot) => (
        <div
          key={dot.key}
          title={dot.label}
          style={{
            position: 'absolute',
            top: dot.y,
            left: `${dot.x}%`,
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderRadius: '50%',
            background: dot.color,
            border: '1.5px solid rgba(10,14,26,0.6)',
            transform: 'translate(-50%, -50%)',
            cursor: 'default',
            boxShadow: dot.pulse ? `0 0 6px ${dot.color}` : 'none',
            animation: dot.pulse ? 'timelinePulse 2s ease-in-out infinite' : 'none',
            zIndex: 2,
          }}
        />
      ))}

      {/* Pulse keyframe */}
      <style>{`
        @keyframes timelinePulse {
          0%, 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.7; transform: translate(-50%, -50%) scale(1.3); }
        }
      `}</style>
    </div>
  )
}
