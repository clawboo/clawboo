import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { formatTokens } from '@/features/cost/costUtils'
import { useCostStore } from '@/stores/cost'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'

// ─── API response types ─────────────────────────────────────────────────────

interface AgentTokenSummary {
  agentId: string
  agentName: string
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  messageCount: number
}

interface TokenSummaryResponse {
  totalToday: number
  totalWeek: number
  totalMonth: number
  tokensToday: number
  tokensWeek: number
  tokensMonth: number
  byAgent: AgentTokenSummary[]
  timeSeries: { date: string; cost: number; tokens: number }[]
}

// ─── Ollama check types ─────────────────────────────────────────────────────

interface OllamaCheckResponse {
  running: boolean
  models: string[]
}

type FrugalPanel = { kind: 'setup' } | { kind: 'picker'; models: string[] } | null

// ─── Ollama setup panel ─────────────────────────────────────────────────────

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
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
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
            cursor: checking ? 'wait' : 'pointer',
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

// ─── Model picker panel ─────────────────────────────────────────────────────

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

// ─── Frugal mode toggle ─────────────────────────────────────────────────────

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

// ─── Summary card (token-first design) ──────────────────────────────────────

function tokenColor(tokens: number): string {
  if (tokens < 10_000) return '#34D399' // mint
  if (tokens < 100_000) return '#FBBF24' // amber
  return '#E94560' // accent
}

function SummaryCard({ label, tokens }: { label: string; tokens: number }) {
  const color = tokenColor(tokens)
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
      <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1, marginBottom: 4 }}>
        {formatTokens(tokens)}
      </div>
      <div style={{ fontSize: 11, color: 'rgba(232,232,232,0.35)' }}>tokens</div>
    </div>
  )
}

// ─── Team breakdown section ─────────────────────────────────────────────────

interface TeamGroup {
  teamId: string | null
  teamName: string
  teamIcon: string
  teamColor: string
  totalTokens: number
  agents: AgentTokenSummary[]
}

function TeamSection({ group }: { group: TeamGroup }) {
  const [open, setOpen] = useState(true)
  const teamTotal = group.totalTokens

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Team header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '8px 4px',
          color: '#E8E8E8',
        }}
      >
        {open ? (
          <ChevronDown size={14} style={{ color: 'rgba(232,232,232,0.4)', flexShrink: 0 }} />
        ) : (
          <ChevronRight size={14} style={{ color: 'rgba(232,232,232,0.4)', flexShrink: 0 }} />
        )}
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            background: `${group.teamColor}22`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          {group.teamIcon}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, textAlign: 'left' }}>
          {group.teamName}
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: tokenColor(group.totalTokens),
            fontFamily: 'var(--font-geist-mono, monospace)',
          }}
        >
          {formatTokens(group.totalTokens)}
        </span>
      </button>

      {/* Agent rows */}
      {open && (
        <div style={{ paddingLeft: 28, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {group.agents.map((agent) => (
            <div key={agent.agentId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <AgentBooAvatar agentId={agent.agentId} size={20} />
              <span
                style={{
                  fontSize: 12,
                  color: 'rgba(232,232,232,0.7)',
                  width: 120,
                  flexShrink: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {agent.agentName}
              </span>
              {/* Token bar */}
              <div
                style={{
                  flex: 1,
                  height: 8,
                  borderRadius: 4,
                  background: 'rgba(255,255,255,0.04)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width:
                      agent.totalTokens > 0 && teamTotal > 0
                        ? `${(agent.totalTokens / teamTotal) * 100}%`
                        : '0%',
                    height: '100%',
                    borderRadius: 4,
                    background: '#34D399',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 11,
                  color: 'rgba(232,232,232,0.5)',
                  fontFamily: 'var(--font-geist-mono, monospace)',
                  width: 90,
                  textAlign: 'right',
                  flexShrink: 0,
                }}
                title={`In: ${formatTokens(agent.inputTokens)} / Out: ${formatTokens(agent.outputTokens)}`}
              >
                {agent.inputTokens > 0 ? (
                  <>
                    {formatTokens(agent.inputTokens)}
                    <span style={{ color: 'rgba(232,232,232,0.25)' }}> / </span>
                    {formatTokens(agent.outputTokens)}
                  </>
                ) : (
                  formatTokens(agent.totalTokens)
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Custom Recharts tooltips ───────────────────────────────────────────────

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

function TokenLineTooltip({ active, payload, label }: TooltipProps) {
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
      <div style={{ color: '#34D399' }}>{formatTokens(item.value)} tokens</div>
    </div>
  )
}

// ─── TokensDashboard (was CostDashboard) ────────────────────────────────────

export function CostDashboard() {
  const { frugalMode, panel, setPanel, handleToggle, handleRetry, activateWithModel } =
    useFrugalToggle()
  const [data, setData] = useState<TokenSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fleetAgents = useFleetStore((s) => s.agents)
  const teams = useTeamStore((s) => s.teams)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetch('/api/cost-records/summary')
      .then((res) => res.json() as Promise<TokenSummaryResponse>)
      .then((json) => {
        if (!cancelled) {
          setData(json)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load token data')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Group ALL fleet agents by team, merging in token data from API where available.
  // This ensures every agent shows up (even with 0 tokens), keeping the dashboard
  // synced with the actual fleet — not just agents that have cost records.
  const teamGroups: TeamGroup[] = useMemo(() => {
    const teamMap = new Map(teams.map((t) => [t.id, t]))

    // Build lookup: agentId → token data from API (if any)
    const tokenDataMap = new Map((data?.byAgent ?? []).map((a) => [a.agentId, a]))

    // Start from ALL fleet agents — not just ones with cost records
    const groups = new Map<string, TeamGroup>()
    const NO_TEAM_KEY = '__no_team__'

    for (const agent of fleetAgents) {
      const teamId = agent.teamId
      const key = teamId ?? NO_TEAM_KEY

      let group = groups.get(key)
      if (!group) {
        const team = teamId ? teamMap.get(teamId) : null
        group = {
          teamId,
          teamName: team?.name ?? 'Unassigned',
          teamIcon: team?.icon ?? '👻',
          teamColor: team?.color ?? '#666',
          totalTokens: 0,
          agents: [],
        }
        groups.set(key, group)
      }

      // Merge API token data or default to zeros
      const tokenData = tokenDataMap.get(agent.id)
      const agentSummary: AgentTokenSummary = tokenData ?? {
        agentId: agent.id,
        agentName: agent.name,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        messageCount: 0,
      }

      group.totalTokens += agentSummary.totalTokens
      group.agents.push(agentSummary)
    }

    // Sort agents within each team by tokens desc
    for (const group of groups.values()) {
      group.agents.sort((a, b) => b.totalTokens - a.totalTokens)
    }

    // Sort teams by total tokens descending, "Unassigned" last
    return Array.from(groups.values()).sort((a, b) => {
      if (a.teamId === null) return 1
      if (b.teamId === null) return -1
      return b.totalTokens - a.totalTokens
    })
  }, [data, fleetAgents, teams])

  const lineData = data?.timeSeries ?? []

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
            Tokens Used
          </h1>
          <p style={{ fontSize: 12, color: 'rgba(232,232,232,0.45)', margin: '4px 0 0' }}>
            Token usage by team and agent
          </p>
        </div>
        <FrugalToggleButton frugalMode={frugalMode} onToggle={() => void handleToggle()} />
      </div>

      {/* Ollama panels */}
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
          Frugal mode active — routing basic tasks to local LLM
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(232,232,232,0.4)' }}>
          Loading token data...
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
          {/* Summary cards — tokens as primary, cost as secondary */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
            <SummaryCard label="Today" tokens={data.tokensToday} />
            <SummaryCard label="This Week" tokens={data.tokensWeek} />
            <SummaryCard label="This Month" tokens={data.tokensMonth} />
          </div>

          {/* Team Breakdown */}
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
                margin: '0 0 12px',
                fontFamily: 'var(--font-geist-mono, monospace)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Tokens by Team
            </h2>

            {teamGroups.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '32px 0',
                  color: 'rgba(232,232,232,0.3)',
                  fontSize: 13,
                }}
              >
                No token records yet. Start chatting with your Boos to track usage.
              </div>
            ) : (
              teamGroups.map((group) => <TeamSection key={group.teamId ?? 'none'} group={group} />)
            )}
          </div>

          {/* Token Trend — 30 day line chart */}
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
              Token Usage — Last 30 Days
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
                  tickFormatter={(v: number) => formatTokens(v)}
                  tick={{ fill: 'rgba(232,232,232,0.4)', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={55}
                />
                <Tooltip content={<TokenLineTooltip />} />
                <Line
                  type="monotone"
                  dataKey="tokens"
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
