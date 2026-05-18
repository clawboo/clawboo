// TeamBriefForm — flat (non-collapsible) editor for a single team's brief.
// Replaces the collapsible TeamBriefEditor used in the old maintenance panel:
// here we manage ONE team at a time (the one whose chat the user has open),
// so the collapse chrome would be wasted.
//
// Used by `TeamSettingsSheet` — opened from the team header gear icon.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Save } from 'lucide-react'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { buildTeamBrief, type TeamBriefMember } from '@/lib/booZeroBrief'
import { detectGenuineLeader, matchedLeadershipKeyword } from '@/lib/genuineLeader'

interface BriefResponse {
  content?: string | null
  updatedAt?: number | null
}

async function fetchTeamBrief(teamId: string): Promise<BriefResponse> {
  const res = await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(teamId)}`)
  if (!res.ok) throw new Error('Failed to load team brief')
  return (await res.json()) as BriefResponse
}

async function putTeamBrief(teamId: string, content: string): Promise<void> {
  const res = await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(teamId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error('Failed to save team brief')
}

export function TeamBriefForm({
  teamId,
  teamName,
  teamIcon,
  templateId,
}: {
  teamId: string
  teamName: string
  teamIcon: string
  templateId: string | null
}) {
  const agents = useFleetStore((s) => s.agents)
  const teamAgents = useMemo(() => agents.filter((a) => a.teamId === teamId), [agents, teamId])

  const [content, setContent] = useState<string>('')
  const [clean, setClean] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchTeamBrief(teamId)
      .then((r) => {
        if (cancelled) return
        const value = r.content && r.content.length > 0 ? r.content : computeDefaultBrief()
        setContent(value)
        setClean(value)
      })
      .catch(() => {
        if (cancelled) return
        const fallback = computeDefaultBrief()
        setContent(fallback)
        setClean(fallback)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId, computeDefaultBrief])

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

  if (loading) {
    return (
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
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ fontSize: 11, color: 'rgba(232,232,232,0.45)', margin: 0 }}>
        Describes this team — read by Boo Zero whenever it operates in {teamName}. Editable; safe to
        regenerate from the current team roster.
      </p>
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
    </div>
  )
}
