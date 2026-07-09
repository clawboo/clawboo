// TeamRulesEditor — user-captured durable rules injected into every team
// agent's preamble. Source of truth: settings table `team-rules:<teamId>`.
// Also writable via `/rule <text>` in the team chat composer.
//
// Used by `TeamSettingsSheet` — opened from the team header gear icon.

import { useCallback, useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'
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
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[12px] leading-relaxed text-foreground/45">
        Durable rules injected into every team agent&apos;s preamble + every Boo Zero turn in this
        team. One rule per line. Also writable via{' '}
        <code className="font-mono text-[11px] text-foreground/70">/rule &lt;text&gt;</code> in the
        team chat composer.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 p-2.5 text-[12px] text-foreground/50">
          <Spinner size={13} /> Loading rules…
        </div>
      ) : (
        <>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={saving}
            spellCheck={false}
            placeholder="No rules yet. Type one per line — they'll be injected into every team agent's preamble."
            className="w-full resize-y rounded-xl border border-border bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
            style={{
              minHeight: 120,
              maxHeight: 320,
            }}
          />
          <div className="flex items-center gap-2.5">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!isDirty}
              loading={saving}
            >
              {!saving && <Save size={14} strokeWidth={2} />}
              Save rules
            </Button>
            {isDirty && (
              <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-amber">
                Unsaved changes
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
