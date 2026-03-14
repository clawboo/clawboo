import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { Slider } from '@/components/ui/slider'
import { mutationQueue } from '@/lib/mutationQueue'
import { useEditorStore } from '@/stores/editor'
import {
  type PersonalityKey,
  type PersonalityValues,
  getDimensions,
  getDimensionText,
  mergeSoulWithPersonality,
  isPersonalityValues,
  stripPersonalityBlock,
} from '@/lib/soulPersonality'

// ─── Constants ───────────────────────────────────────────────────────────────

const SOUL_FILE = 'SOUL.md'

const DEFAULT_VALUES: PersonalityValues = {
  verbosity: 50,
  humor: 50,
  caution: 50,
  speed_cost: 50,
  formality: 50,
}

const DIMENSIONS = getDimensions()

const SLIDER_LABELS: Record<PersonalityKey, { left: string; right: string }> = {
  verbosity: { left: 'Terse', right: 'Verbose' },
  humor: { left: 'Serious', right: 'Witty' },
  caution: { left: 'Bold', right: 'Careful' },
  speed_cost: { left: 'Fast', right: 'Economical' },
  formality: { left: 'Casual', right: 'Formal' },
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PersonalitySliders({ agentId: propAgentId }: { agentId?: string } = {}) {
  const client = useConnectionStore((s) => s.client)
  const storeAgentId = useFleetStore((s) => s.selectedAgentId)
  const selectedAgentId = propAgentId ?? storeAgentId

  const [values, setValues] = useState<PersonalityValues>({ ...DEFAULT_VALUES })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef<PersonalityValues | null>(null)
  /** Cache of the base SOUL.md content (role description, without personality block) */
  const baseSoulRef = useRef<string>('')

  // Load personality values from SQLite + base SOUL.md content on mount.
  useEffect(() => {
    if (!selectedAgentId) return
    setLoading(true)
    setError(null)
    setValues({ ...DEFAULT_VALUES })
    baseSoulRef.current = ''

    // Fetch both SQLite personality values and existing SOUL.md in parallel
    const sqlitePromise = fetch(`/api/personality?agentId=${encodeURIComponent(selectedAgentId)}`)
      .then((res) => res.json())
      .then((data: { values: PersonalityValues | null }) => {
        if (data.values && isPersonalityValues(data.values)) {
          setValues(data.values)
        }
      })
      .catch(() => {})

    const soulPromise = client
      ? client.agents.files
          .read(selectedAgentId, SOUL_FILE)
          .then((content) => {
            // Cache the base content (without any existing personality block)
            baseSoulRef.current = stripPersonalityBlock(content)
          })
          .catch(() => {})
      : Promise.resolve()

    void Promise.all([sqlitePromise, soulPromise]).finally(() => setLoading(false))

    return () => {
      if (savedTimer.current) {
        clearTimeout(savedTimer.current)
        savedTimer.current = null
      }
      const dirty = dirtyRef.current
      if (dirty && client) {
        dirtyRef.current = null
        // Best-effort save to both SQLite and SOUL.md on agent switch
        void fetch('/api/personality', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: selectedAgentId, values: dirty }),
        }).catch(() => {})
        // Merge personality into existing SOUL.md (preserve role description)
        const mergedContent = mergeSoulWithPersonality(baseSoulRef.current, dirty)
        void mutationQueue
          .enqueue(selectedAgentId, () =>
            client.agents.files.set(selectedAgentId, SOUL_FILE, mergedContent),
          )
          .catch(() => {})
      }
    }
  }, [client, selectedAgentId])

  // handleChange: updates local state + marks dirty (no save call).
  const handleChange = useCallback((key: PersonalityKey, value: number) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      dirtyRef.current = next
      return next
    })
  }, [])

  // handleCommit: fires on pointer-up / keyboard commit.
  // Saves to BOTH SQLite and SOUL.md (merged with existing role description).
  const handleCommit = useCallback(
    (key: PersonalityKey, value: number) => {
      if (!client || !selectedAgentId) return
      const next = { ...values, [key]: value }
      setValues(next)
      dirtyRef.current = null

      if (savedTimer.current) clearTimeout(savedTimer.current)
      setSaved(false)
      setSaving(true)
      setError(null)

      // 1. Save to SQLite — persistent source of truth for slider values
      const sqliteSave = fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, values: next }),
      })

      // 2. Read existing SOUL.md, merge personality sections, write back
      //    This preserves the role description AND adds personality instructions.
      void (async () => {
        try {
          // Read fresh base content (in case user edited SOUL.md via editor)
          const existing = await client.agents.files.read(selectedAgentId, SOUL_FILE)
          baseSoulRef.current = stripPersonalityBlock(existing)
          const mergedContent = mergeSoulWithPersonality(baseSoulRef.current, next)
          await mutationQueue.enqueue(selectedAgentId, () =>
            client.agents.files.set(selectedAgentId, SOUL_FILE, mergedContent),
          )
        } catch (err: unknown) {
          console.warn('[Personality] SOUL.md merge/write failed (non-fatal):', err)
        }
      })()

      // Wait for SQLite save (the important one) — SOUL.md is best-effort
      void sqliteSave
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setSaved(true)
          savedTimer.current = setTimeout(() => setSaved(false), 2000)
          // Signal the editor to refresh SOUL.md if it's open
          useEditorStore.getState().triggerSoulRefresh()
        })
        .catch((err: unknown) => {
          dirtyRef.current = next
          setError(err instanceof Error ? err.message : 'Save failed')
        })
        .finally(() => setSaving(false))
    },
    [client, selectedAgentId, values],
  )

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!selectedAgentId) {
    return (
      <div className="flex items-center justify-center py-8 text-[12px] text-secondary/50">
        Select an agent to configure its personality.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-secondary/60">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-[12px]">Loading personality…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Sliders */}
      {DIMENSIONS.map((dim) => {
        const labels = SLIDER_LABELS[dim.key]
        return (
          <div key={dim.key} className="space-y-2">
            <div className="flex items-center justify-between">
              <span
                className="text-[13px] font-semibold text-text"
                style={{ fontFamily: 'var(--font-body)' }}
              >
                {dim.label}
              </span>
              <span
                className="min-w-[2.5rem] text-right text-[11px] tabular-nums text-secondary"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                {values[dim.key]}
              </span>
            </div>

            <Slider
              value={[values[dim.key]]}
              min={0}
              max={100}
              step={1}
              onValueChange={(vals) => handleChange(dim.key, vals[0] ?? 50)}
              onValueCommit={(vals) => handleCommit(dim.key, vals[0] ?? 50)}
            />

            <div className="flex justify-between">
              <span className="text-[10px] text-secondary/50">{labels.left}</span>
              <span className="text-[10px] text-secondary/50">{labels.right}</span>
            </div>

            <p className="text-[11px] leading-relaxed text-secondary/70">
              {getDimensionText(dim.key, values[dim.key])}
            </p>
          </div>
        )
      })}

      {/* Footer: preview toggle + save status */}
      <div className="flex items-center justify-between border-t border-white/8 pt-3">
        <button
          type="button"
          onClick={() => setShowPreview((p) => !p)}
          className="flex items-center gap-1.5 text-[11px] text-secondary/50 transition-colors hover:text-secondary"
        >
          <FileText className="h-3.5 w-3.5" />
          {showPreview ? 'Hide' : 'Preview'} SOUL.md
        </button>

        <div className="flex items-center gap-2">
          {saving && (
            <span className="flex items-center gap-1 text-[11px] text-secondary/60">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving…
            </span>
          )}
          {saved && !saving && <span className="text-[11px] text-mint">Saved ✓</span>}
          {error && !saving && <span className="text-[11px] text-destructive">{error}</span>}
        </div>
      </div>

      {/* SOUL.md preview — shows merged content (role description + personality) */}
      {showPreview && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-white/8 bg-surface p-3">
          <pre
            className="whitespace-pre-wrap text-[10px] leading-relaxed text-secondary/70"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {mergeSoulWithPersonality(baseSoulRef.current, values)}
          </pre>
        </div>
      )}
    </div>
  )
}
