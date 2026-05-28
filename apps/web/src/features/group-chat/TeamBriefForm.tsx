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
      <div className="flex items-center gap-2 p-4 text-[11px] text-foreground/50">
        <Loader2 size={12} className="animate-spin" /> Loading brief…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[11px] text-foreground/45">
        Describes this team — read by Boo Zero whenever it operates in {teamName}. Editable; safe to
        regenerate from the current team roster.
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={saving}
        spellCheck={false}
        className="w-full resize-y rounded-md border border-border bg-input p-2.5 font-mono text-[12px] leading-relaxed text-foreground"
        style={{ minHeight: 200, maxHeight: 420, fontFamily: 'var(--font-geist-mono, monospace)' }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || saving}
          className={[
            'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold',
            isDirty
              ? 'cursor-pointer border-primary/30 bg-primary text-primary-foreground'
              : 'cursor-default border-border bg-foreground/[0.06] text-foreground/50',
          ].join(' ')}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={saving}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-foreground/[0.04] px-2.5 text-[11px] font-semibold text-foreground/70 disabled:cursor-default"
          title="Regenerate from current team members (does not save until you press Save)"
        >
          <RefreshCw size={12} />
          Regenerate
        </button>
        {isDirty && <span className="text-[10px] text-amber">Unsaved changes</span>}
      </div>
    </div>
  )
}
