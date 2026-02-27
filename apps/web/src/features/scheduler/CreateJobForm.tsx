'use client'

import { useState, useCallback } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { GatewayClient } from '@clawboo/gateway-client'
import type { AgentState } from '@/stores/fleet'
import type { CronJob } from '@/stores/scheduler'
import {
  CRON_PRESETS,
  formatScheduleHuman,
  getNextExecution,
  type GatewayCronCreateInput,
  type GatewayCronJobsResult,
  type GatewayCronJobSummary,
} from './cronUtils'
import { CronExpressionHelper } from './CronExpressionHelper'

// ─── Schedule mode ─────────────────────────────────────────────────────────────

type ScheduleMode = 'preset' | 'every-custom' | 'cron-expr'

// ─── Gateway helpers ───────────────────────────────────────────────────────────
// Typed wrappers around client.call() using the real cron API method names
// Gateway cron API methods: cron.add, cron.list, cron.run, cron.remove.

async function gatewayCreateCronJob(
  client: GatewayClient,
  input: GatewayCronCreateInput,
): Promise<GatewayCronJobSummary> {
  return client.call<GatewayCronJobSummary>('cron.add', input)
}

export async function gatewayListCronJobs(client: GatewayClient): Promise<GatewayCronJobsResult> {
  return client.call<GatewayCronJobsResult>('cron.list', { includeDisabled: true })
}

// ─── Mapping from gateway summary to CronJob ───────────────────────────────────

export function mapGatewayJobToCronJob(raw: GatewayCronJobSummary, agents: AgentState[]): CronJob {
  const agent = agents.find((a) => a.id === raw.agentId)
  const agentName = agent?.name ?? raw.agentId ?? 'Unknown'

  const schedule = {
    kind: raw.schedule.kind,
    ...(raw.schedule.kind === 'every'
      ? { everyMs: raw.schedule.everyMs, anchorMs: raw.schedule.anchorMs }
      : {}),
    ...(raw.schedule.kind === 'at' ? { at: raw.schedule.at } : {}),
    ...(raw.schedule.kind === 'cron' ? { expr: raw.schedule.expr, tz: raw.schedule.tz } : {}),
  } as CronJob['schedule']

  const taskText = raw.payload.kind === 'agentTurn' ? raw.payload.message : raw.payload.text

  const nextMs = raw.state.nextRunAtMs ?? null
  const nextExecution =
    nextMs ?? (raw.enabled ? (getNextExecution(schedule)?.getTime() ?? null) : null)

  return {
    id: raw.id,
    name: raw.name,
    agentId: raw.agentId ?? '',
    agentName,
    schedule,
    task: taskText,
    active: raw.enabled,
    nextExecution,
    lastExecution: raw.state.lastRunAtMs ?? null,
    lastStatus: raw.state.lastStatus ?? null,
    lastError: raw.state.lastError ?? null,
    lastDurationMs: raw.state.lastDurationMs ?? null,
    updatedAtMs: raw.updatedAtMs,
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CreateJobFormProps {
  client: GatewayClient
  agents: AgentState[]
  onCreated: (jobs: CronJob[]) => void
}

// ─── CreateJobForm ─────────────────────────────────────────────────────────────

export function CreateJobForm({ client, agents, onCreated }: CreateJobFormProps) {
  // Form state
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '')
  const [jobName, setJobName] = useState('')
  const [task, setTask] = useState('')
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('preset')
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0)
  // Every-custom fields
  const [customEveryAmount, setCustomEveryAmount] = useState('5')
  const [customEveryUnit, setCustomEveryUnit] = useState<'minutes' | 'hours' | 'days'>('minutes')
  // Cron expr fields
  const [cronExpr, setCronExpr] = useState('')
  const [cronTz, setCronTz] = useState('')

  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Derived schedule preview
  const resolvedScheduleLabel = (() => {
    if (scheduleMode === 'preset') {
      const preset = CRON_PRESETS[selectedPresetIndex]
      return preset ? formatScheduleHuman({ kind: 'every', everyMs: preset.everyMs }) : ''
    }
    if (scheduleMode === 'every-custom') {
      const amount = Number.parseInt(customEveryAmount, 10)
      if (!Number.isFinite(amount) || amount <= 0) return 'Invalid amount'
      const multiplier =
        customEveryUnit === 'minutes'
          ? 60_000
          : customEveryUnit === 'hours'
            ? 3_600_000
            : 86_400_000
      return formatScheduleHuman({ kind: 'every', everyMs: amount * multiplier })
    }
    if (scheduleMode === 'cron-expr') {
      return cronExpr.trim() || ''
    }
    return ''
  })()

  const buildScheduleInput = useCallback((): GatewayCronCreateInput['schedule'] | null => {
    if (scheduleMode === 'preset') {
      const preset = CRON_PRESETS[selectedPresetIndex]
      if (!preset) return null
      return { kind: 'every', everyMs: preset.everyMs }
    }
    if (scheduleMode === 'every-custom') {
      const amount = Number.parseInt(customEveryAmount, 10)
      if (!Number.isFinite(amount) || amount <= 0) return null
      const multiplier =
        customEveryUnit === 'minutes'
          ? 60_000
          : customEveryUnit === 'hours'
            ? 3_600_000
            : 86_400_000
      return { kind: 'every', everyMs: amount * multiplier }
    }
    if (scheduleMode === 'cron-expr' && cronExpr.trim()) {
      return {
        kind: 'cron',
        expr: cronExpr.trim(),
        ...(cronTz.trim() ? { tz: cronTz.trim() } : {}),
      }
    }
    return null
  }, [scheduleMode, selectedPresetIndex, customEveryAmount, customEveryUnit, cronExpr, cronTz])

  const handleSubmit = useCallback(async () => {
    setError(null)
    setSuccessMsg(null)

    const trimmedAgentId = agentId.trim()
    if (!trimmedAgentId) {
      setError('Please select an agent.')
      return
    }

    const trimmedName = jobName.trim()
    if (!trimmedName) {
      setError('Job name is required.')
      return
    }

    const trimmedTask = task.trim()
    if (!trimmedTask) {
      setError('Task description is required.')
      return
    }

    const schedule = buildScheduleInput()
    if (!schedule) {
      setError('Please configure a valid schedule.')
      return
    }

    const input: GatewayCronCreateInput = {
      name: trimmedName,
      agentId: trimmedAgentId,
      enabled: true,
      schedule,
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: trimmedTask },
      delivery: { mode: 'none' },
    }

    setIsBusy(true)
    try {
      await gatewayCreateCronJob(client, input)
      const listResult = await gatewayListCronJobs(client)
      const mapped = listResult.jobs.map((raw) => mapGatewayJobToCronJob(raw, agents))
      // Sort by updatedAtMs descending
      mapped.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      onCreated(mapped)
      setSuccessMsg(`"${trimmedName}" scheduled.`)
      // Reset form
      setJobName('')
      setTask('')
      setScheduleMode('preset')
      setSelectedPresetIndex(0)
      setCronExpr('')
      setCronTz('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create scheduled job.')
    } finally {
      setIsBusy(false)
    }
  }, [agentId, jobName, task, buildScheduleInput, client, agents, onCreated])

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8,
    color: '#E8E8E8',
    fontSize: 13,
    padding: '8px 10px',
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(232,232,232,0.5)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    marginBottom: 4,
    display: 'block',
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    borderRadius: 6,
    border: active ? '1px solid rgba(233,69,96,0.3)' : '1px solid rgba(255,255,255,0.08)',
    background: active ? 'rgba(233,69,96,0.1)' : 'transparent',
    color: active ? '#E94560' : 'rgba(232,232,232,0.45)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s',
  })

  return (
    <div
      style={{
        padding: '20px 20px 16px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <p
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: '#E8E8E8',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Plus size={14} style={{ color: '#E94560' }} />
        Create Schedule
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Agent picker */}
        <div>
          <label style={labelStyle}>Agent</label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {agents.length === 0 && <option value="">No agents connected</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {/* Job name */}
        <div>
          <label style={labelStyle}>Job Name</label>
          <input
            type="text"
            placeholder="e.g. Morning brief"
            value={jobName}
            onChange={(e) => setJobName(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>

      {/* Task description */}
      <div style={{ marginTop: 12 }}>
        <label style={labelStyle}>Task (what the agent should do)</label>
        <textarea
          placeholder="e.g. Summarize the latest news and send a report."
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={2}
          style={{
            ...inputStyle,
            resize: 'vertical',
            lineHeight: '1.5',
          }}
        />
      </div>

      {/* Schedule section */}
      <div style={{ marginTop: 12 }}>
        <label style={labelStyle}>Schedule</label>

        {/* Mode tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button
            style={tabStyle(scheduleMode === 'preset')}
            onClick={() => setScheduleMode('preset')}
          >
            Presets
          </button>
          <button
            style={tabStyle(scheduleMode === 'every-custom')}
            onClick={() => setScheduleMode('every-custom')}
          >
            Custom interval
          </button>
          <button
            style={tabStyle(scheduleMode === 'cron-expr')}
            onClick={() => setScheduleMode('cron-expr')}
          >
            Cron expression
          </button>
        </div>

        {/* Preset picker */}
        {scheduleMode === 'preset' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CRON_PRESETS.map((preset, i) => (
              <button
                key={preset.label}
                onClick={() => setSelectedPresetIndex(i)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border:
                    selectedPresetIndex === i
                      ? '1px solid rgba(251,191,36,0.4)'
                      : '1px solid rgba(255,255,255,0.08)',
                  background:
                    selectedPresetIndex === i ? 'rgba(251,191,36,0.1)' : 'rgba(255,255,255,0.03)',
                  color: selectedPresetIndex === i ? '#FBBF24' : 'rgba(232,232,232,0.5)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-geist-mono, monospace)',
                  transition: 'all 0.15s',
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}

        {/* Every-custom fields */}
        {scheduleMode === 'every-custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'rgba(232,232,232,0.5)' }}>Every</span>
            <input
              type="number"
              min={1}
              value={customEveryAmount}
              onChange={(e) => setCustomEveryAmount(e.target.value)}
              style={{ ...inputStyle, width: 72 }}
            />
            <select
              value={customEveryUnit}
              onChange={(e) => setCustomEveryUnit(e.target.value as 'minutes' | 'hours' | 'days')}
              style={{ ...inputStyle, width: 100, cursor: 'pointer' }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        )}

        {/* Cron expression */}
        {scheduleMode === 'cron-expr' && (
          <div>
            <input
              type="text"
              placeholder="*/5 * * * *"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              style={{
                ...inputStyle,
                fontFamily: 'var(--font-geist-mono, monospace)',
                letterSpacing: '0.03em',
              }}
            />
            <CronExpressionHelper expression={cronExpr} />
            <div style={{ marginTop: 8 }}>
              <label style={{ ...labelStyle, textTransform: 'none', fontSize: 11 }}>
                Timezone (optional, e.g. America/New_York)
              </label>
              <input
                type="text"
                placeholder="UTC"
                value={cronTz}
                onChange={(e) => setCronTz(e.target.value)}
                style={{ ...inputStyle, fontFamily: 'var(--font-geist-mono, monospace)' }}
              />
            </div>
          </div>
        )}

        {/* Schedule preview */}
        {resolvedScheduleLabel && scheduleMode !== 'cron-expr' && (
          <p
            style={{
              marginTop: 8,
              fontSize: 11,
              color: '#FBBF24',
              fontFamily: 'var(--font-geist-mono, monospace)',
            }}
          >
            Runs {resolvedScheduleLabel}
          </p>
        )}
      </div>

      {/* Error / success */}
      {error && <p style={{ fontSize: 12, color: '#E94560', marginTop: 10 }}>{error}</p>}
      {successMsg && <p style={{ fontSize: 12, color: '#34D399', marginTop: 10 }}>{successMsg}</p>}

      {/* Submit */}
      <div style={{ marginTop: 14 }}>
        <button
          onClick={handleSubmit}
          disabled={isBusy || agents.length === 0}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 18px',
            borderRadius: 8,
            background: isBusy ? 'rgba(233,69,96,0.15)' : 'rgba(233,69,96,0.18)',
            border: '1px solid rgba(233,69,96,0.35)',
            color: '#E94560',
            fontSize: 13,
            fontWeight: 600,
            cursor: isBusy || agents.length === 0 ? 'not-allowed' : 'pointer',
            opacity: agents.length === 0 ? 0.4 : 1,
            transition: 'all 0.15s',
          }}
        >
          {isBusy ? (
            <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
          ) : (
            <Plus size={13} />
          )}
          {isBusy ? 'Creating...' : 'Create Schedule'}
        </button>
      </div>
    </div>
  )
}
