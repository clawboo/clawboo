import { useEffect, useState, useMemo } from 'react'
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts'
import { BarChart3, ChevronDown, ChevronRight } from 'lucide-react'
import { formatTokens } from '@/features/cost/costUtils'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { EmptyState } from '@/features/shared/EmptyState'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Skeleton } from '@/features/shared/Skeleton'

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

// ─── Summary card (token-first design) ──────────────────────────────────────

function tokenColor(tokens: number): string {
  if (tokens < 10_000) return 'var(--mint)' // mint
  if (tokens < 100_000) return 'var(--amber)' // amber
  return 'var(--primary)' // accent
}

function SummaryCard({ label, tokens }: { label: string; tokens: number }) {
  const color = tokenColor(tokens)
  return (
    <div
      className="rounded-2xl border border-border bg-surface"
      style={{
        flex: 1,
        minWidth: 150,
        padding: '18px 22px',
        boxShadow: 'var(--shadow-raised)',
        transition: 'transform var(--motion-fast), box-shadow var(--motion-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = 'var(--shadow-floating)'
        e.currentTarget.style.transform = 'translateY(-1px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'var(--shadow-raised)'
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      <div
        className="font-mono uppercase"
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.14em',
          color: 'rgb(var(--foreground-rgb) / 0.45)',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        className="font-data"
        style={{
          fontSize: 28,
          fontWeight: 700,
          color,
          lineHeight: 1,
          marginBottom: 4,
          letterSpacing: '-0.02em',
        }}
      >
        {formatTokens(tokens)}
      </div>
      <div style={{ fontSize: 11, color: 'rgb(var(--foreground-rgb) / 0.35)' }}>tokens</div>
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
          color: 'var(--foreground)',
        }}
      >
        {open ? (
          <ChevronDown
            size={14}
            style={{ color: 'rgb(var(--foreground-rgb) / 0.4)', flexShrink: 0 }}
          />
        ) : (
          <ChevronRight
            size={14}
            style={{ color: 'rgb(var(--foreground-rgb) / 0.4)', flexShrink: 0 }}
          />
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
                  color: 'rgb(var(--foreground-rgb) / 0.7)',
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
                  background: 'rgb(var(--foreground-rgb) / 0.04)',
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
                    background: 'var(--mint)',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 11,
                  color: 'rgb(var(--foreground-rgb) / 0.5)',
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
                    <span style={{ color: 'rgb(var(--foreground-rgb) / 0.25)' }}> / </span>
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
        background: 'var(--card)',
        border: '1px solid var(--mint)',
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        color: 'var(--foreground)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ color: 'var(--mint)' }}>{formatTokens(item.value)} tokens</div>
    </div>
  )
}

// ─── TokensDashboard (was CostDashboard) ────────────────────────────────────

export function CostDashboard() {
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
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      <PanelHeader
        title="Tokens Used"
        subtitle="Token usage by team and agent"
        icon={BarChart3}
        size="md"
        border
        actions={<GitHubStarButton />}
      />

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={92} width="30%" radius={16} />
              ))}
            </div>
            <Skeleton height={220} radius={16} />
          </div>
        )}

        {error && (
          <FormattedAlert tone="error" style={{ marginBottom: 20 }}>
            {error}
          </FormattedAlert>
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
              className="rounded-2xl border border-border bg-surface"
              style={{
                padding: '20px 20px 12px',
                marginBottom: 20,
                boxShadow: 'var(--shadow-raised)',
              }}
            >
              <h2
                className="font-mono uppercase"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'rgb(var(--foreground-rgb) / 0.45)',
                  margin: '0 0 16px',
                  letterSpacing: '0.14em',
                }}
              >
                Tokens by Team
              </h2>

              {teamGroups.length === 0 ? (
                <EmptyState
                  icon={BarChart3}
                  title="No token records yet"
                  helper="Start chatting with your Boos to track usage."
                  paddingTop={28}
                />
              ) : (
                teamGroups.map((group) => (
                  <TeamSection key={group.teamId ?? 'none'} group={group} />
                ))
              )}
            </div>

            {/* Token Trend — 30 day line chart */}
            <div
              className="rounded-2xl border border-border bg-surface"
              style={{ padding: '20px 20px 12px', boxShadow: 'var(--shadow-raised)' }}
            >
              <h2
                className="font-mono uppercase"
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'rgb(var(--foreground-rgb) / 0.45)',
                  margin: '0 0 16px',
                  letterSpacing: '0.14em',
                }}
              >
                Token Usage — Last 30 Days
              </h2>

              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={lineData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 4" stroke="rgb(var(--foreground-rgb) / 0.05)" />
                  <XAxis
                    dataKey="date"
                    tick={{
                      fill: 'rgb(var(--foreground-rgb) / 0.4)',
                      fontSize: 10,
                      style: { fontVariantNumeric: 'tabular-nums' },
                    }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(v: number) => formatTokens(v)}
                    tick={{
                      fill: 'rgb(var(--foreground-rgb) / 0.4)',
                      fontSize: 10,
                      style: { fontVariantNumeric: 'tabular-nums' },
                    }}
                    axisLine={false}
                    tickLine={false}
                    width={55}
                  />
                  <Tooltip content={<TokenLineTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="tokens"
                    stroke="var(--mint)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{
                      r: 4,
                      fill: 'var(--mint)',
                      stroke: 'var(--background)',
                      strokeWidth: 2,
                    }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
