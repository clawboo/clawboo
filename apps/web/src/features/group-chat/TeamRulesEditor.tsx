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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <p style={{ fontSize: 11, color: 'rgba(232,232,232,0.45)', margin: 0 }}>
        Durable rules injected into every team agent&apos;s preamble + every Boo Zero turn in this
        team. One rule per line. Also writable via <code>/rule &lt;text&gt;</code> in the team chat
        composer.
      </p>
      {loading ? (
        <div
          style={{
            padding: 10,
            fontSize: 11,
            color: 'rgba(232,232,232,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
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
            style={{
              width: '100%',
              minHeight: 120,
              maxHeight: 320,
              padding: 8,
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
                height: 26,
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
              Save rules
            </button>
            {isDirty && <span style={{ fontSize: 10, color: '#FBBF24' }}>Unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  )
}
