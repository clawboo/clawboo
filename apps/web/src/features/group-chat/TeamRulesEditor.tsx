// TeamRulesEditor — user-captured durable rules injected into every team
// agent's preamble. Source of truth: settings table `team-rules:<teamId>`.
// Also writable via `/rule <text>` in the team chat composer.
//
// Used by `TeamSettingsSheet` — opened from the team header gear icon.

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { useToastStore } from '@/stores/toast'
import { fetchTeamRules as fetchTeamRulesContent, saveTeamRules } from '@/lib/teamRules'

export function TeamRulesEditor({ teamId }: { teamId: string }) {
  const [content, setContent] = useState<string>('')
  const [clean, setClean] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchTeamRulesContent(teamId)
      .then((value) => {
        if (cancelled) return
        setContent(value)
        setClean(value)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [teamId])

  const isDirty = content !== clean

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const ok = await saveTeamRules(teamId, content)
      if (ok) {
        setClean(content)
        useToastStore.getState().addToast({ message: 'Team rules saved.', type: 'success' })
      } else {
        useToastStore.getState().addToast({ message: 'Could not save rules.', type: 'error' })
      }
    } finally {
      setSaving(false)
    }
  }, [content, teamId])

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[11px] text-foreground/45">
        Durable rules injected into every team agent&apos;s preamble + every Boo Zero turn in this
        team. One rule per line. Also writable via <code>/rule &lt;text&gt;</code> in the team chat
        composer.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 p-2.5 text-[11px] text-foreground/50">
          <Loader2 size={12} className="animate-spin" /> Loading rules…
        </div>
      ) : (
        <>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={saving}
            spellCheck={false}
            placeholder="No rules yet. Type one per line — they'll be injected into every team agent's preamble."
            className="w-full resize-y rounded-md border border-border bg-input p-2 font-mono text-[12px] leading-relaxed text-foreground"
            style={{
              minHeight: 120,
              maxHeight: 320,
              fontFamily: 'var(--font-geist-mono, monospace)',
            }}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={!isDirty || saving}
              className={[
                'inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold',
                isDirty
                  ? 'cursor-pointer border-primary/30 bg-primary text-primary-foreground'
                  : 'cursor-default border-border bg-foreground/[0.06] text-foreground/50',
              ].join(' ')}
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save rules
            </button>
            {isDirty && <span className="text-[10px] text-amber">Unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  )
}
