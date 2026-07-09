// GlobalBriefEditor — Boo Zero's overall responsibilities + auto-generated
// index of the teams it leads. Stored in SQLite via `/api/boo-zero/global-brief`
// and injected into Boo Zero's context preamble on every interaction.
//
// The `## Required behavior` section inside the brief is sourced from the
// canonical `buildBooZeroRulesBlock` so what the user sees here matches
// what the LLM sees at runtime (see `lib/booZeroBrief.ts`).
//
// Lives under `features/boo-zero/` because the editor is Boo-Zero-agent-
// scoped. Rendered by the Boo Zero individual agent's `Brief` tab in
// `InlineEditor`.

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import { Button } from '@/features/shared/Button'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { buildGlobalBrief } from '@/lib/booZeroBrief'

interface BriefResponse {
  content?: string | null
  updatedAt?: number | null
}

async function fetchGlobalBrief(): Promise<BriefResponse> {
  const res = await fetch('/api/boo-zero/global-brief')
  if (!res.ok) throw new Error('Failed to load global brief')
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

export function GlobalBriefEditor() {
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
      <p style={{ fontSize: 11, color: 'rgb(var(--foreground-rgb) / 0.45)', margin: 0 }}>
        Boo Zero&apos;s overall responsibilities + the list of teams it leads. Injected into Boo
        Zero&apos;s context preamble on every interaction.
      </p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={loading || saving}
        spellCheck={false}
        className="font-mono"
        style={{
          width: '100%',
          minHeight: 240,
          maxHeight: 480,
          padding: 12,
          fontSize: 12,
          lineHeight: 1.55,
          background: 'var(--input)',
          color: 'var(--foreground)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button
          variant="primary"
          size="sm"
          disabled={!isDirty || saving || loading}
          loading={saving}
          onClick={handleSave}
        >
          <Save size={12} strokeWidth={2} />
          Save
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading || saving}
          onClick={handleRegenerate}
          title="Regenerate from current team list (does not save yet)"
        >
          <RefreshCw size={12} strokeWidth={2} />
          Regenerate from teams
        </Button>
        {isDirty && <span style={{ fontSize: 10, color: 'var(--amber)' }}>Unsaved changes</span>}
      </div>
    </div>
  )
}
