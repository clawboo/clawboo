'use client'

import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Play, Trash2, Loader2 } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import type { CronJob } from '@/stores/scheduler'
import { formatRelativeTime, formatScheduleHuman } from './cronUtils'

interface CronJobRowProps {
  job: CronJob
  onToggle: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onRunNow: (id: string) => Promise<void>
}

// ─── Ticking relative time ─────────────────────────────────────────────────────
// Re-renders every 15s so "in 3 minutes" stays fresh without hammering React.

function RelativeTime({ timestampMs }: { timestampMs: number | null }) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  if (timestampMs === null) return <span style={{ color: 'rgba(232,232,232,0.25)' }}>—</span>

  const date = new Date(timestampMs)
  const rel = formatRelativeTime(date)

  return (
    <span title={date.toLocaleString()} style={{ color: 'rgba(232,232,232,0.6)', fontSize: 12 }}>
      {rel}
    </span>
  )
}

// ─── Last run status dot ───────────────────────────────────────────────────────

function LastRunCell({
  lastExecution,
  lastStatus,
}: {
  lastExecution: number | null
  lastStatus: CronJob['lastStatus']
}) {
  if (lastExecution === null) {
    return <span style={{ color: 'rgba(232,232,232,0.25)', fontSize: 12 }}>Never</span>
  }

  const color = lastStatus === 'ok' ? '#34D399' : lastStatus === 'error' ? '#E94560' : '#FBBF24'

  const label = lastStatus === 'ok' ? 'Success' : lastStatus === 'error' ? 'Error' : 'Skipped'

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      <span style={{ color: 'rgba(232,232,232,0.6)', fontSize: 12 }}>
        {label} · <RelativeTime timestampMs={lastExecution} />
      </span>
    </span>
  )
}

// ─── CronJobRow ───────────────────────────────────────────────────────────────

export function CronJobRow({ job, onToggle, onDelete, onRunNow }: CronJobRowProps) {
  const [toggleBusy, setToggleBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [runBusy, setRunBusy] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleToggle = async () => {
    if (toggleBusy) return
    setToggleBusy(true)
    try {
      await onToggle(job.id)
    } finally {
      if (mountedRef.current) setToggleBusy(false)
    }
  }

  const handleDelete = async () => {
    if (deleteBusy) return
    setDeleteBusy(true)
    try {
      await onDelete(job.id)
    } finally {
      if (mountedRef.current) setDeleteBusy(false)
    }
  }

  const handleRunNow = async () => {
    if (runBusy) return
    setRunBusy(true)
    try {
      await onRunNow(job.id)
    } finally {
      if (mountedRef.current) setRunBusy(false)
    }
  }

  const scheduleLabel = formatScheduleHuman(job.schedule)

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18 }}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr 1fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '10px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        opacity: job.active ? 1 : 0.5,
        transition: 'opacity 0.2s',
      }}
    >
      {/* Agent column */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            borderRadius: 6,
            boxShadow: '0 0 0 1.5px rgba(255,255,255,0.06)',
            background: '#0A0E1A',
          }}
        >
          <BooAvatar seed={job.agentId} size={28} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#E8E8E8',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.name}
          </p>
          <p
            style={{
              fontSize: 11,
              color: 'rgba(232,232,232,0.45)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.agentName}
          </p>
        </div>
      </div>

      {/* Schedule column */}
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            fontSize: 12,
            color: '#FBBF24',
            fontFamily: 'var(--font-geist-mono, monospace)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={scheduleLabel}
        >
          {scheduleLabel}
        </p>
        <p
          style={{
            fontSize: 11,
            color: 'rgba(232,232,232,0.4)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 2,
          }}
          title={job.task}
        >
          {job.task}
        </p>
      </div>

      {/* Next run column */}
      <div>
        <p style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)', marginBottom: 2 }}>Next run</p>
        <RelativeTime timestampMs={job.nextExecution} />
      </div>

      {/* Last run column */}
      <div>
        <p style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)', marginBottom: 2 }}>Last run</p>
        <LastRunCell lastExecution={job.lastExecution} lastStatus={job.lastStatus} />
      </div>

      {/* Actions column */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Active toggle */}
        <button
          onClick={handleToggle}
          disabled={toggleBusy}
          title={job.active ? 'Disable' : 'Enable'}
          style={{
            position: 'relative',
            display: 'inline-flex',
            width: 32,
            height: 18,
            borderRadius: 9,
            background: job.active ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.08)',
            border: job.active
              ? '1px solid rgba(52,211,153,0.4)'
              : '1px solid rgba(255,255,255,0.1)',
            cursor: toggleBusy ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            flexShrink: 0,
            padding: 0,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: job.active ? 14 : 2,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: job.active ? '#34D399' : 'rgba(232,232,232,0.35)',
              transition: 'all 0.2s',
            }}
          />
        </button>

        {/* Run Now button */}
        <button
          onClick={handleRunNow}
          disabled={runBusy}
          title="Run now"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 6,
            background: runBusy ? 'rgba(52,211,153,0.08)' : 'rgba(52,211,153,0.1)',
            border: '1px solid rgba(52,211,153,0.2)',
            color: '#34D399',
            cursor: runBusy ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
            flexShrink: 0,
          }}
        >
          {runBusy ? (
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          ) : (
            <Play size={11} fill="#34D399" />
          )}
        </button>

        {/* Delete button */}
        <button
          onClick={handleDelete}
          disabled={deleteBusy}
          title="Delete job"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 6,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            color: deleteBusy ? 'rgba(233,69,96,0.4)' : 'rgba(232,232,232,0.35)',
            cursor: deleteBusy ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
            flexShrink: 0,
          }}
        >
          {deleteBusy ? (
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          ) : (
            <Trash2 size={12} />
          )}
        </button>
      </div>
    </motion.div>
  )
}
