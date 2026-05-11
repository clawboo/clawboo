// Boo Zero brief management — global brief + per-team briefs.
// Lives inside MaintenancePanel ("System" view). SQLite-backed (Phase 1
// API routes), surfaced as editable virtual files. Boo Zero reads briefs
// at runtime via the context preamble injection in `groupChatSendOperation`
// and `ChatPanel` (when the user `@TeamName`s in Boo Zero's individual chat).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, Save, ChevronRight } from 'lucide-react'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useBooZeroStore } from '@/stores/booZero'
import { useToastStore } from '@/stores/toast'
import { buildGlobalBrief, buildTeamBrief, type TeamBriefMember } from '@/lib/booZeroBrief'
import { detectGenuineLeader, matchedLeadershipKeyword } from '@/lib/genuineLeader'

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface BriefResponse {
  content?: string | null
  updatedAt?: number | null
}

async function fetchGlobalBrief(): Promise<BriefResponse> {
  const res = await fetch('/api/boo-zero/global-brief')
  if (!res.ok) throw new Error('Failed to load global brief')
  return (await res.json()) as BriefResponse
}

async function fetchTeamBrief(teamId: string): Promise<BriefResponse> {
  const res = await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(teamId)}`)
  if (!res.ok) throw new Error('Failed to load team brief')
  return (await res.json()) as BriefResponse
}

async function putGlobalBrief(content: string): Promise<void> {
  const res = await fetch('/api/boo-zero/global-brief', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error('Failed to save global brief')
}

async function putTeamBrief(teamId: string, content: string): Promise<void> {
  const res = await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(teamId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error('Failed to save team brief')
}

// ─── Global brief sub-section ────────────────────────────────────────────────

function GlobalBriefEditor() {
  const teams = useTeamStore((s) => s.teams)
  const teamsRef = useRef(teams)
  teamsRef.current = teams

  const [content, setContent] = useState<string>('')
  const [clean, setClean] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)
  const seededRef = useRef<boolean>(false)

  useEffect(() => {
    // Intentionally seed exactly once on mount. Subsequent team changes
    // shouldn't blow away user edits — they can press "Regenerate" if they
    // want a fresh draft from the current team list. `teamsRef` is read at
    // load-time so the initial default still reflects the current state.
    if (seededRef.current) return
    seededRef.current = true
    let cancelled = false
    setLoading(true)
    fetchGlobalBrief()
      .then((r) => {
        if (cancelled) return
        const value =
          r.content && r.content.length > 0
            ? r.content
            : buildGlobalBrief({
                teams: teamsRef.current.map((t) => ({ name: t.name, icon: t.icon })),
              })
        setContent(value)
        setClean(value)
      })
      .catch(() => {
        if (cancelled) return
        const fallback = buildGlobalBrief({
          teams: teamsRef.current.map((t) => ({ name: t.name, icon: t.icon })),
        })
        setContent(fallback)
        setClean(fallback)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const isDirty = content !== clean

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await putGlobalBrief(content)
      setClean(content)
      useToastStore.getState().addToast({ type: 'success', message: 'Global brief saved' })
    } catch (e) {
      useToastStore
        .getState()
        .addToast({ type: 'error', message: (e as Error).message ?? 'Save failed' })
    } finally {
      setSaving(false)
    }
  }, [content])

  const handleRegenerate = useCallback(() => {
    const fresh = buildGlobalBrief({
      teams: teams.map((t) => ({ name: t.name, icon: t.icon })),
    })
    setContent(fresh)
  }, [teams])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 11, color: 'rgba(232,232,232,0.45)', margin: 0 }}>
        Boo Zero&apos;s overall responsibilities + the list of teams it leads. Injected into Boo
        Zero&apos;s context preamble on every interaction.
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={loading || saving}
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 240,
          maxHeight: 480,
          padding: 12,
          fontSize: 12,
          fontFamily: 'var(--font-geist-mono, monospace)',
          lineHeight: 1.55,
          background: 'rgba(13,17,23,0.85)',
          color: '#E8E8E8',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saving || loading}
          style={{
            height: 30,
            padding: '0 12px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.1)',
            background: isDirty ? '#E94560' : 'rgba(255,255,255,0.06)',
            color: isDirty ? '#fff' : 'rgba(232,232,232,0.5)',
            cursor: !isDirty || saving || loading ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={loading || saving}
          style={{
            height: 30,
            padding: '0 12px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.04)',
            color: 'rgba(232,232,232,0.7)',
            cursor: loading || saving ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
          title="Regenerate from current team list (does not save yet)"
        >
          <RefreshCw size={12} />
          Regenerate from teams
        </button>
        {isDirty && <span style={{ fontSize: 10, color: '#FBBF24' }}>Unsaved changes</span>}
      </div>
    </div>
  )
}

// ─── Team brief sub-section ──────────────────────────────────────────────────

function TeamBriefEditor({
  teamId,
  teamName,
  teamIcon,
  templateId,
  teamColor,
  collapsed,
  onToggle,
}: {
  teamId: string
  teamName: string
  teamIcon: string
  templateId: string | null
  teamColor: string
  collapsed: boolean
  onToggle: () => void
}) {
  const agents = useFleetStore((s) => s.agents)
  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])

  const [content, setContent] = useState<string>('')
  const [clean, setClean] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)
  const [loadedOnce, setLoadedOnce] = useState<boolean>(false)

  const computeDefaultBrief = useCallback((): string => {
    const genuineLead =
      teamAgents.find((a) => detectGenuineLeader({ name: a.name, role: a.name })) ?? null
    const matched = genuineLead
      ? matchedLeadershipKeyword({ name: genuineLead.name, role: genuineLead.name })
      : null
    const members: TeamBriefMember[] = teamAgents.map((a) => ({
      name: a.name,
      role: a.name,
    }))
    return buildTeamBrief({
      team: { name: teamName, icon: teamIcon, templateId, description: null },
      members,
      internalLead:
        genuineLead && matched ? { agentName: genuineLead.name, matchedKeyword: matched } : null,
    })
  }, [teamAgents, teamName, teamIcon, templateId])

  // Load when expanded (lazy).
  useEffect(() => {
    if (collapsed || loadedOnce) return
    let cancelled = false
    setLoading(true)
    fetchTeamBrief(teamId)
      .then((r) => {
        if (cancelled) return
        const value = r.content && r.content.length > 0 ? r.content : computeDefaultBrief()
        setContent(value)
        setClean(value)
        setLoadedOnce(true)
      })
      .catch(() => {
        if (cancelled) return
        const fallback = computeDefaultBrief()
        setContent(fallback)
        setClean(fallback)
        setLoadedOnce(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collapsed, loadedOnce, teamId, computeDefaultBrief])

  const isDirty = content !== clean

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await putTeamBrief(teamId, content)
      setClean(content)
      useToastStore.getState().addToast({ type: 'success', message: `Brief for ${teamName} saved` })
    } catch (e) {
      useToastStore
        .getState()
        .addToast({ type: 'error', message: (e as Error).message ?? 'Save failed' })
    } finally {
      setSaving(false)
    }
  }, [teamId, teamName, content])

  const handleRegenerate = useCallback(() => {
    setContent(computeDefaultBrief())
  }, [computeDefaultBrief])

  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.02)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: '#E8E8E8',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 12,
          textAlign: 'left',
        }}
        aria-expanded={!collapsed}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            background: `${teamColor}22`,
            fontSize: 13,
          }}
        >
          {teamIcon}
        </span>
        <span style={{ flex: 1, fontWeight: 600 }}>{teamName}</span>
        <span style={{ fontSize: 10, color: 'rgba(232,232,232,0.4)' }}>
          {teamAgents.length} {teamAgents.length === 1 ? 'agent' : 'agents'}
        </span>
        <ChevronRight
          size={14}
          style={{
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.15s ease',
            opacity: 0.5,
          }}
        />
      </button>
      {!collapsed && (
        <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading && !loadedOnce ? (
            <div
              style={{
                padding: 16,
                fontSize: 11,
                color: 'rgba(232,232,232,0.5)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Loader2 size={12} className="animate-spin" /> Loading brief…
            </div>
          ) : (
            <>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={saving}
                spellCheck={false}
                style={{
                  width: '100%',
                  minHeight: 200,
                  maxHeight: 420,
                  padding: 10,
                  fontSize: 12,
                  fontFamily: 'var(--font-geist-mono, monospace)',
                  lineHeight: 1.55,
                  background: 'rgba(13,17,23,0.85)',
                  color: '#E8E8E8',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!isDirty || saving}
                  style={{
                    height: 28,
                    padding: '0 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.1)',
                    background: isDirty ? '#E94560' : 'rgba(255,255,255,0.06)',
                    color: isDirty ? '#fff' : 'rgba(232,232,232,0.5)',
                    cursor: !isDirty || saving ? 'default' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleRegenerate}
                  disabled={saving}
                  style={{
                    height: 28,
                    padding: '0 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.1)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(232,232,232,0.7)',
                    cursor: saving ? 'default' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                  title="Regenerate from current team members (does not save until you press Save)"
                >
                  <RefreshCw size={12} />
                  Regenerate
                </button>
                {isDirty && <span style={{ fontSize: 10, color: '#FBBF24' }}>Unsaved changes</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Top-level panel ─────────────────────────────────────────────────────────

export function BooZeroBriefsPanel() {
  const teams = useTeamStore((s) => s.teams).filter((t) => !t.isArchived)
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const agents = useFleetStore((s) => s.agents)
  const booZeroAgent = booZeroAgentId ? (agents.find((a) => a.id === booZeroAgentId) ?? null) : null

  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!booZeroAgent && (
        <div
          style={{
            padding: 10,
            fontSize: 11,
            color: '#FBBF24',
            border: '1px solid rgba(251,191,36,0.3)',
            borderRadius: 6,
            background: 'rgba(251,191,36,0.05)',
          }}
          data-testid="boo-zero-missing-banner"
        >
          Boo Zero is missing from the fleet. Briefs are still editable, but there&apos;s no agent
          to receive them until a primary agent is identified.
        </div>
      )}

      {/* Global brief */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 600,
            color: 'rgba(232,232,232,0.85)',
          }}
        >
          Global brief
        </h3>
        <GlobalBriefEditor />
      </div>

      {/* Per-team briefs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h3
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 600,
            color: 'rgba(232,232,232,0.85)',
          }}
        >
          Per-team briefs
        </h3>
        {teams.length === 0 && (
          <p style={{ fontSize: 11, color: 'rgba(232,232,232,0.45)', margin: 0 }}>
            No teams deployed yet. Briefs appear here once you deploy your first team.
          </p>
        )}
        {teams.map((team) => (
          <TeamBriefEditor
            key={team.id}
            teamId={team.id}
            teamName={team.name}
            teamIcon={team.icon}
            teamColor={team.color}
            templateId={team.templateId ?? null}
            collapsed={expandedTeamId !== team.id}
            onToggle={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
          />
        ))}
      </div>
    </div>
  )
}
