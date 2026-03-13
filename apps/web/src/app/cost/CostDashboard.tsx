import { useEffect, useState, useCallback } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts'
import { formatCost, formatTokens } from '@/features/cost/costUtils'
import { useCostStore } from '@/stores/cost'
import { useConnectionStore } from '@/stores/connection'
// ─── API response types ─────────────────────────────────────────────────────────

interface AgentCostSummary {
  agentId: string
  agentName: string
  totalCost: number
  totalTokens: number
  messageCount: number
}

interface CostSummaryResponse {
  totalToday: number
  totalWeek: number
  totalMonth: number
  byAgent: AgentCostSummary[]
  timeSeries: { date: string; cost: number }[]
}

// ─── Ollama check types ─────────────────────────────────────────────────────────

interface OllamaCheckResponse {
  running: boolean
  models: string[]
}

type FrugalPanel = { kind: 'setup' } | { kind: 'picker'; models: string[] } | null

// ─── Ollama setup panel ─────────────────────────────────────────────────────────

function OllamaSetupPanel({ onCancel, onRetry }: { onCancel: () => void; onRetry: () => void }) {
  const [checking, setChecking] = useState(false)

  const handleRetry = useCallback(async () => {
    setChecking(true)
    await onRetry()
    setChecking(false)
  }, [onRetry])

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text)
  }, [])

  const steps = [
    {
      label: 'Install Ollama',
      macOS: 'brew install ollama',
      linux: 'curl -fsSL https://ollama.com/install.sh | sh',
    },
    { label: 'Pull a model', cmd: 'ollama pull llama3.2' },
    { label: 'Start Ollama', cmd: 'ollama serve' },
  ]

  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid rgba(251,191,36,0.3)',
        borderRadius: 12,
        padding: '20px 24px',
        marginBottom: 20,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: '#FBBF24', marginBottom: 4 }}>
        Ollama not detected
      </div>
      <div style={{ fontSize: 12, color: 'rgba(232,232,232,0.5)', marginBottom: 16 }}>
        Frugal mode requires Ollama running locally. Follow these steps:
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {steps.map((step, i) => (
          <div key={i}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#E8E8E8', marginBottom: 6 }}>
              {i + 1}. {step.label}
            </div>
            {'cmd' in step && step.cmd ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code
                  style={{
                    flex: 1,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 12,
                    color: '#34D399',
                    fontFamily: 'var(--font-geist-mono, monospace)',
                  }}
                >
                  {step.cmd}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(step.cmd!)}
                  title="Copy"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 6,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    color: 'rgba(232,232,232,0.6)',
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  Copy
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { os: 'macOS', cmd: step.macOS! },
                  { os: 'Linux', cmd: step.linux! },
                ].map(({ os, cmd }) => (
                  <div key={os} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 11,
                        color: 'rgba(232,232,232,0.4)',
                        width: 48,
                        flexShrink: 0,
                      }}
                    >
                      {os}
                    </span>
                    <code
                      style={{
                        flex: 1,
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 6,
                        padding: '6px 10px',
                        fontSize: 12,
                        color: '#34D399',
                        fontFamily: 'var(--font-geist-mono, monospace)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {cmd}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(cmd)}
                      title="Copy"
                      style={{
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 6,
                        padding: '6px 8px',
                        cursor: 'pointer',
                        color: 'rgba(232,232,232,0.6)',
                        fontSize: 11,
                        flexShrink: 0,
                      }}
                    >
                      Copy
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={checking}
          style={{
            background: '#FBBF24',
            color: '#0A0E1A',
            border: 'none',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: checking ? 'default' : 'pointer',
            opacity: checking ? 0.6 : 1,
          }}
        >
          {checking ? 'Checking...' : 'Check again'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'transparent',
            color: 'rgba(232,232,232,0.5)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Model picker panel ─────────────────────────────────────────────────────────

function ModelPickerPanel({
  models,
  onSelect,
  onCancel,
}: {
  models: string[]
  onSelect: (model: string) => void
  onCancel: () => void
}) {
  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid rgba(52,211,153,0.3)',
        borderRadius: 12,
        padding: '20px 24px',
        marginBottom: 20,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: '#34D399', marginBottom: 4 }}>
        Select a model
      </div>
      <div style={{ fontSize: 12, color: 'rgba(232,232,232,0.5)', marginBottom: 14 }}>
        llama3.2 not found. Pick an available model or pull llama3.2 first.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {models.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSelect(m)}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: 12,
              color: '#E8E8E8',
              cursor: 'pointer',
              fontFamily: 'var(--font-geist-mono, monospace)',
            }}
          >
            {m}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onCancel}
        style={{
          background: 'transparent',
          color: 'rgba(232,232,232,0.5)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: '8px 16px',
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
    </div>
  )
}

// ─── Frugal mode toggle ────────────────────────────────────────────────────────

function useFrugalToggle() {
  const frugalMode = useCostStore((s) => s.frugalMode)
  const toggleFrugalMode = useCostStore((s) => s.toggleFrugalMode)
  const client = useConnectionStore((s) => s.client)
  const [panel, setPanel] = useState<FrugalPanel>(null)

  const checkOllama = useCallback(async (): Promise<OllamaCheckResponse> => {
    try {
      const res = await fetch('/api/ollama-check')
      return (await res.json()) as OllamaCheckResponse
    } catch {
      return { running: false, models: [] }
    }
  }, [])

  const activateWithModel = useCallback(
    async (model: string) => {
      toggleFrugalMode()
      setPanel(null)
      if (!client) return
      try {
        await client.config.patch({ model: `ollama/${model}` })
      } catch {
        // Best-effort
      }
    },
    [toggleFrugalMode, client],
  )

  const handleToggle = useCallback(async () => {
    // Turning OFF
    if (frugalMode) {
      toggleFrugalMode()
      setPanel(null)
      if (!client) return
      try {
        await client.config.patch({ model: null })
      } catch {
        // Best-effort
      }
      return
    }

    // Turning ON — check Ollama first
    const check = await checkOllama()

    if (!check.running) {
      setPanel({ kind: 'setup' })
      return
    }

    const hasLlama = check.models.some((m) => m.startsWith('llama3.2'))
    if (!hasLlama) {
      if (check.models.length > 0) {
        setPanel({ kind: 'picker', models: check.models })
      } else {
        setPanel({ kind: 'setup' })
      }
      return
    }

    // Happy path
    await activateWithModel('llama3.2')
  }, [frugalMode, toggleFrugalMode, client, checkOllama, activateWithModel])

  const handleRetry = useCallback(async () => {
    const check = await checkOllama()
    if (!check.running) return

    const hasLlama = check.models.some((m) => m.startsWith('llama3.2'))
    if (hasLlama) {
      await activateWithModel('llama3.2')
    } else if (check.models.length > 0) {
      setPanel({ kind: 'picker', models: check.models })
    }
  }, [checkOllama, activateWithModel])

  return { frugalMode, panel, setPanel, handleToggle, handleRetry, activateWithModel }
}

function FrugalToggleButton({
  frugalMode,
  onToggle,
}: {
  frugalMode: boolean
  onToggle: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#E8E8E8', marginBottom: 2 }}>
          Frugal Mode
        </div>
        <div style={{ fontSize: 11, color: frugalMode ? '#FBBF24' : 'rgba(232,232,232,0.45)' }}>
          {frugalMode ? 'Using local LLM (Ollama / LM Studio)' : 'Using cloud LLM'}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-label={frugalMode ? 'Disable frugal mode' : 'Enable frugal mode'}
        aria-pressed={frugalMode}
        style={{
          width: 48,
          height: 26,
          borderRadius: 13,
          border: 'none',
          background: frugalMode ? '#FBBF24' : 'rgba(255,255,255,0.12)',
          cursor: 'pointer',
          position: 'relative',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: frugalMode ? 25 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.2s',
          }}
        />
      </button>
    </div>
  )
}

// ─── Summary card ──────────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string
  cost: number
  tokens?: number
}

function costColor(usd: number): string {
  if (usd < 0.5) return '#34D399' // mint — low
  if (usd < 5) return '#FBBF24' // amber — medium
  return '#E94560' // accent — high
}

function SummaryCard({ label, cost, tokens }: SummaryCardProps) {
  const color = costColor(cost)
  return (
    <div
      style={{
        flex: 1,
        minWidth: 140,
        background: '#111827',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.06)',
        padding: '16px 20px',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'rgba(232,232,232,0.45)',
          marginBottom: 8,
          fontFamily: 'var(--font-geist-mono, monospace)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color, lineHeight: 1, marginBottom: 6 }}>
        {formatCost(cost)}
      </div>
      {tokens !== undefined && (
        <div style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)' }}>
          {formatTokens(tokens)} tokens
        </div>
      )}
    </div>
  )
}

// ─── Custom Recharts tooltips ──────────────────────────────────────────────────

interface TooltipPayloadItem {
  value: number
  name: string
  payload: Record<string, unknown>
}

interface TooltipProps {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
}

function CustomBarTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null
  const item = payload[0]!
  const tokens =
    typeof item.payload['tokens'] === 'number' ? (item.payload['tokens'] as number) : undefined
  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid #E94560',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        color: '#E8E8E8',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div>{formatCost(item.value)}</div>
      {tokens !== undefined && (
        <div style={{ color: 'rgba(232,232,232,0.55)', marginTop: 2 }}>
          {formatTokens(tokens)} tokens
        </div>
      )}
    </div>
  )
}

function CustomLineTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null
  const item = payload[0]!
  return (
    <div
      style={{
        background: '#111827',
        border: '1px solid #34D399',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        color: '#E8E8E8',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#34D399' }}>{formatCost(item.value)}</div>
    </div>
  )
}

// ─── CostDashboard ────────────────────────────────────────────────────────────

export function CostDashboard() {
  const { frugalMode, panel, setPanel, handleToggle, handleRetry, activateWithModel } =
    useFrugalToggle()
  const [data, setData] = useState<CostSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetch('/api/cost-records/summary')
      .then((res) => res.json() as Promise<CostSummaryResponse>)
      .then((json) => {
        if (!cancelled) {
          setData(json)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load cost data')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const barData = (data?.byAgent ?? []).slice(0, 12).map((a) => ({
    name: a.agentName.length > 16 ? `${a.agentName.slice(0, 14)}...` : a.agentName,
    cost: Number(a.totalCost.toFixed(4)),
    tokens: a.totalTokens,
  }))

  const lineData = data?.timeSeries ?? []

  const totalTokens = data?.byAgent.reduce((sum, a) => sum + a.totalTokens, 0) ?? 0

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: '#0A0E1A',
        padding: '24px 28px',
        color: '#E8E8E8',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: '#E8E8E8',
              margin: 0,
              fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
            }}
          >
            Cost Tracking
          </h1>
          <p style={{ fontSize: 12, color: 'rgba(232,232,232,0.45)', margin: '4px 0 0' }}>
            Token usage and spend across all Boos
          </p>
        </div>
        <FrugalToggleButton frugalMode={frugalMode} onToggle={() => void handleToggle()} />
      </div>

      {/* Ollama setup / model picker panels */}
      {panel?.kind === 'setup' && (
        <OllamaSetupPanel onCancel={() => setPanel(null)} onRetry={handleRetry} />
      )}
      {panel?.kind === 'picker' && (
        <ModelPickerPanel
          models={panel.models}
          onSelect={(m) => void activateWithModel(m)}
          onCancel={() => setPanel(null)}
        />
      )}

      {/* Frugal mode banner */}
      {frugalMode && (
        <div
          style={{
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: 8,
            padding: '10px 16px',
            marginBottom: 20,
            fontSize: 13,
            color: '#FBBF24',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontSize: 16 }}>!</span>
          Frugal mode active — routing basic tasks to local LLM (Ollama / LM Studio)
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,232,232,0.4)' }}>
          Loading cost data...
        </div>
      )}

      {error && (
        <div
          style={{
            background: 'rgba(233,69,96,0.08)',
            border: '1px solid rgba(233,69,96,0.3)',
            borderRadius: 8,
            padding: '12px 16px',
            color: '#E94560',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
            <SummaryCard label="Today" cost={data.totalToday} tokens={totalTokens} />
            <SummaryCard label="This Week" cost={data.totalWeek} />
            <SummaryCard label="This Month" cost={data.totalMonth} />
          </div>

          {/* Cost by Agent — horizontal bar chart */}
          <div
            style={{
              background: '#111827',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.06)',
              padding: '20px 20px 12px',
              marginBottom: 20,
            }}
          >
            <h2
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'rgba(232,232,232,0.65)',
                margin: '0 0 16px',
                fontFamily: 'var(--font-geist-mono, monospace)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Cost by Agent
            </h2>

            {barData.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '32px 0',
                  color: 'rgba(232,232,232,0.3)',
                  fontSize: 13,
                }}
              >
                No cost records yet. Start chatting with your Boos to track spend.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(160, barData.length * 44)}>
                <BarChart
                  layout="vertical"
                  data={barData}
                  margin={{ top: 0, right: 24, left: 0, bottom: 0 }}
                >
                  <XAxis
                    type="number"
                    tickFormatter={(v: number) => formatCost(v)}
                    tick={{ fill: 'rgba(232,232,232,0.4)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={110}
                    tick={{ fill: 'rgba(232,232,232,0.7)', fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    content={<CustomBarTooltip />}
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  />
                  <Bar dataKey="cost" fill="#E94560" radius={[0, 4, 4, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Cost over time — line chart */}
          <div
            style={{
              background: '#111827',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.06)',
              padding: '20px 20px 12px',
            }}
          >
            <h2
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'rgba(232,232,232,0.65)',
                margin: '0 0 16px',
                fontFamily: 'var(--font-geist-mono, monospace)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Cost Over Time — Last 30 Days
            </h2>

            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={lineData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 4" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'rgba(232,232,232,0.4)', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={(v: number) => formatCost(v)}
                  tick={{ fill: 'rgba(232,232,232,0.4)', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={55}
                />
                <Tooltip content={<CustomLineTooltip />} />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="#34D399"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: '#34D399', stroke: '#0A0E1A', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}
