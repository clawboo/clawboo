'use client'

import { useEffect, useCallback, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { CalendarClock, RefreshCw, Loader2, AlertCircle } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useSchedulerStore, type CronJob } from '@/stores/scheduler'
import type { GatewayClient } from '@clawboo/gateway-client'
import { CronJobRow } from './CronJobRow'
import { CreateJobForm, mapGatewayJobToCronJob, gatewayListCronJobs } from './CreateJobForm'
import type {
  GatewayCronJobSummary,
  GatewayCronRunResult,
  GatewayCronRemoveResult,
} from './cronUtils'

// ─── Gateway action helpers ────────────────────────────────────────────────────

async function gatewayRunJobNow(
  client: GatewayClient,
  jobId: string,
): Promise<GatewayCronRunResult> {
  return client.call<GatewayCronRunResult>('cron.run', { id: jobId, mode: 'force' })
}

async function gatewayRemoveJob(
  client: GatewayClient,
  jobId: string,
): Promise<GatewayCronRemoveResult> {
  return client.call<GatewayCronRemoveResult>('cron.remove', { id: jobId })
}

// ─── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'rgba(232,232,232,0.25)',
        padding: 40,
      }}
    >
      <CalendarClock size={36} strokeWidth={1.2} />
      <p style={{ fontSize: 14, fontWeight: 500 }}>No scheduled jobs</p>
      <p style={{ fontSize: 12, textAlign: 'center', maxWidth: 280, lineHeight: 1.6 }}>
        Create a schedule below to automate tasks for any Boo agent. Jobs run even while you are
        away.
      </p>
    </div>
  )
}

// ─── Column header row ─────────────────────────────────────────────────────────

function TableHeader() {
  const colStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(232,232,232,0.35)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    padding: '8px 16px',
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr 1fr auto',
        gap: 12,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div style={colStyle}>Agent / Job</div>
      <div style={colStyle}>Schedule / Task</div>
      <div style={colStyle}>Next Run</div>
      <div style={colStyle}>Last Run</div>
      <div style={{ ...colStyle, minWidth: 100 }}>Actions</div>
    </div>
  )
}

// ─── Grouped job list (by agent) ──────────────────────────────────────────────

interface GroupedJobListProps {
  jobs: CronJob[]
  onToggle: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onRunNow: (id: string) => Promise<void>
}

function GroupedJobList({ jobs, onToggle, onDelete, onRunNow }: GroupedJobListProps) {
  // Group jobs by agentId, preserving agent order by first occurrence
  const agentOrder: string[] = []
  const grouped = new Map<string, CronJob[]>()

  for (const job of jobs) {
    if (!grouped.has(job.agentId)) {
      grouped.set(job.agentId, [])
      agentOrder.push(job.agentId)
    }
    grouped.get(job.agentId)!.push(job)
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {agentOrder.map((agentId) => {
        const agentJobs = grouped.get(agentId)!
        const agentName = agentJobs[0]?.agentName ?? agentId

        return (
          <div key={agentId}>
            {/* Agent group header */}
            <div
              style={{
                padding: '6px 16px',
                fontSize: 11,
                fontWeight: 600,
                color: 'rgba(232,232,232,0.35)',
                background: 'rgba(255,255,255,0.015)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                letterSpacing: '0.04em',
              }}
            >
              {agentName}
            </div>
            <AnimatePresence initial={false}>
              {agentJobs.map((job) => (
                <CronJobRow
                  key={job.id}
                  job={job}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onRunNow={onRunNow}
                />
              ))}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}

// ─── SchedulerPanel ────────────────────────────────────────────────────────────

export function SchedulerPanel() {
  const client = useConnectionStore((s) => s.client)
  const agents = useFleetStore((s) => s.agents)
  const { jobs, isLoading, loadError, setJobs, removeJob, toggleJob, setLoading, setLoadError } =
    useSchedulerStore()

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // ── Load jobs ─────────────────────────────────────────────────────────────────

  const loadJobs = useCallback(async () => {
    if (!client) return
    setLoading(true)
    setLoadError(null)
    try {
      const result = await gatewayListCronJobs(client)
      if (!mountedRef.current) return
      const mapped: CronJob[] = result.jobs.map((raw: GatewayCronJobSummary) =>
        mapGatewayJobToCronJob(raw, agents),
      )
      // Sort by updatedAtMs descending
      mapped.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      setJobs(mapped)
    } catch (err) {
      if (!mountedRef.current) return
      setLoadError(err instanceof Error ? err.message : 'Failed to load scheduled jobs.')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [client, agents, setJobs, setLoading, setLoadError])

  // Load jobs when client connects. `loadJobs` is stable (memoised with useCallback)
  // so adding it to deps here is safe — it only changes when client changes anyway.
  useEffect(() => {
    void loadJobs()
  }, [loadJobs])

  // ── Actions ───────────────────────────────────────────────────────────────────

  const handleToggle = useCallback(
    async (id: string) => {
      if (!client) return
      const job = jobs.find((j) => j.id === id)
      if (!job) return

      if (job.active) {
        // Disabling: remove the job from the gateway
        toggleJob(id) // optimistic
        try {
          const result = await gatewayRemoveJob(client, id)
          if (!result.ok) {
            toggleJob(id) // revert
            return
          }
          removeJob(id)
        } catch {
          toggleJob(id) // revert
        }
      } else {
        // Cannot re-enable a removed job — inform via alert
        alert(
          'This job was removed from the scheduler. To re-enable it, create a new schedule with the same settings.',
        )
      }
    },
    [client, jobs, toggleJob, removeJob],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      if (!client) return
      try {
        await gatewayRemoveJob(client, id)
        removeJob(id)
      } catch (err) {
        console.error('Failed to delete cron job:', err)
      }
    },
    [client, removeJob],
  )

  const handleRunNow = useCallback(
    async (id: string) => {
      if (!client) return
      try {
        await gatewayRunJobNow(client, id)
        // Refresh the list to pick up updated lastRunAtMs
        await loadJobs()
      } catch (err) {
        console.error('Failed to run cron job now:', err)
      }
    },
    [client, loadJobs],
  )

  const handleCreated = useCallback(
    (freshJobs: CronJob[]) => {
      setJobs(freshJobs)
    },
    [setJobs],
  )

  // ── Render ─────────────────────────────────────────────────────────────────────

  const isConnected = client !== null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#0A0E1A',
        overflow: 'hidden',
      }}
    >
      {/* Panel toolbar */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(232,232,232,0.5)' }}>
            Scheduler
          </span>
          {jobs.length > 0 && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: '#FBBF24',
                background: 'rgba(251,191,36,0.1)',
                borderRadius: 20,
                padding: '1px 8px',
              }}
            >
              {jobs.length} job{jobs.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Refresh button */}
        <button
          onClick={() => void loadJobs()}
          disabled={isLoading || !isConnected}
          title="Refresh jobs"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '3px 10px',
            borderRadius: 6,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(232,232,232,0.4)',
            fontSize: 11,
            cursor: isLoading || !isConnected ? 'not-allowed' : 'pointer',
            opacity: !isConnected ? 0.4 : 1,
            transition: 'all 0.15s',
          }}
        >
          {isLoading ? (
            <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
          ) : (
            <RefreshCw size={11} />
          )}
          Refresh
        </button>
      </div>

      {/* Not connected state */}
      {!isConnected && (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            color: 'rgba(232,232,232,0.25)',
          }}
        >
          <CalendarClock size={32} strokeWidth={1.2} />
          <p style={{ fontSize: 13 }}>Connect to a gateway to manage schedules.</p>
        </div>
      )}

      {/* Connected: show content */}
      {isConnected && (
        <>
          {/* Loading spinner (initial load only, no jobs yet) */}
          {isLoading && jobs.length === 0 && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: 'rgba(232,232,232,0.35)',
              }}
            >
              <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13 }}>Loading jobs…</span>
            </div>
          )}

          {/* Error state */}
          {loadError && jobs.length === 0 && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: '#E94560',
              }}
            >
              <AlertCircle size={24} strokeWidth={1.5} />
              <p style={{ fontSize: 13, maxWidth: 320, textAlign: 'center' }}>{loadError}</p>
              <button
                onClick={() => void loadJobs()}
                style={{
                  marginTop: 4,
                  padding: '6px 14px',
                  borderRadius: 6,
                  background: 'rgba(233,69,96,0.1)',
                  border: '1px solid rgba(233,69,96,0.3)',
                  color: '#E94560',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Retry
              </button>
            </div>
          )}

          {/* Job list */}
          {!isLoading && !loadError && jobs.length === 0 && <EmptyState />}

          {jobs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <TableHeader />
              <GroupedJobList
                jobs={jobs}
                onToggle={handleToggle}
                onDelete={handleDelete}
                onRunNow={handleRunNow}
              />
            </div>
          )}

          {/* Create job form */}
          <CreateJobForm client={client} agents={agents} onCreated={handleCreated} />
        </>
      )}

      {/* Keyframe for spinner — injected once */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
