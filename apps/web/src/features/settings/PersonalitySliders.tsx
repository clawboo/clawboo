import { readAgentFile, writeAgentFile } from '@clawboo/control-client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Check, FileText, PenLine, SlidersHorizontal } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/features/shared/Button'
import { Spinner } from '@/features/shared/Spinner'
import { mutationQueue } from '@/lib/mutationQueue'
import { useEditorStore } from '@/stores/editor'
import {
  type PersonalityKey,
  type PersonalityValues,
  getDimensions,
  getDimensionText,
  mergeSoulWithPersonality,
  mergeSoulWithCustomPersonality,
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
  const [customMode, setCustomMode] = useState(false)
  const [customText, setCustomText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef<PersonalityValues | null>(null)
  const customTextDirtyRef = useRef(false)
  /** Cache of the base SOUL.md content (role description, without personality block) */
  const baseSoulRef = useRef<string>('')

  // Load personality values from SQLite + base SOUL.md content on mount.
  useEffect(() => {
    if (!selectedAgentId) return
    setLoading(true)
    setError(null)
    setValues({ ...DEFAULT_VALUES })
    setCustomMode(false)
    setCustomText('')
    baseSoulRef.current = ''

    // Fetch both SQLite personality values and existing SOUL.md in parallel
    const sqlitePromise = fetch(`/api/personality?agentId=${encodeURIComponent(selectedAgentId)}`)
      .then((res) => res.json())
      .then((data: { values: PersonalityValues | null; customText?: string | null }) => {
        if (data.values && isPersonalityValues(data.values)) {
          setValues(data.values)
        }
        if (data.customText && typeof data.customText === 'string') {
          setCustomMode(true)
          setCustomText(data.customText)
        }
      })
      .catch(() => {})

    const soulPromise = client
      ? readAgentFile(selectedAgentId, SOUL_FILE)
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
          .enqueue(selectedAgentId, () => writeAgentFile(selectedAgentId, SOUL_FILE, mergedContent))
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
        body: JSON.stringify({ agentId: selectedAgentId, values: next, customText: null }),
      })

      // 2. Read existing SOUL.md, merge personality sections, write back
      //    This preserves the role description AND adds personality instructions.
      void (async () => {
        try {
          // Read fresh base content (in case user edited SOUL.md via editor)
          const existing = await readAgentFile(selectedAgentId, SOUL_FILE)
          baseSoulRef.current = stripPersonalityBlock(existing)
          const mergedContent = mergeSoulWithPersonality(baseSoulRef.current, next)
          await mutationQueue.enqueue(selectedAgentId, () =>
            writeAgentFile(selectedAgentId, SOUL_FILE, mergedContent),
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

  // ─── Custom text save ────────────────────────────────────────────────────────

  const saveCustomText = useCallback(
    (text: string) => {
      if (!client || !selectedAgentId) return
      if (!text.trim()) return

      customTextDirtyRef.current = false
      if (savedTimer.current) clearTimeout(savedTimer.current)
      setSaved(false)
      setSaving(true)
      setError(null)

      // 1. Save to SQLite with custom text
      const sqliteSave = fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, values, customText: text }),
      })

      // 2. Merge custom text into SOUL.md
      void (async () => {
        try {
          const existing = await readAgentFile(selectedAgentId, SOUL_FILE)
          baseSoulRef.current = stripPersonalityBlock(existing)
          const mergedContent = mergeSoulWithCustomPersonality(baseSoulRef.current, text)
          await mutationQueue.enqueue(selectedAgentId, () =>
            writeAgentFile(selectedAgentId, SOUL_FILE, mergedContent),
          )
        } catch (err: unknown) {
          console.warn('[Personality] Custom SOUL.md merge/write failed (non-fatal):', err)
        }
      })()

      void sqliteSave
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          setSaved(true)
          savedTimer.current = setTimeout(() => setSaved(false), 2000)
          useEditorStore.getState().triggerSoulRefresh()
        })
        .catch((err: unknown) => {
          customTextDirtyRef.current = true
          setError(err instanceof Error ? err.message : 'Save failed')
        })
        .finally(() => setSaving(false))
    },
    [client, selectedAgentId, values],
  )

  // ─── Mode toggle ──────────────────────────────────────────────────────────────

  const toggleMode = useCallback(() => {
    if (!client || !selectedAgentId) return

    if (customMode) {
      // Switching back to sliders — clear custom text and restore slider personality
      setCustomMode(false)
      setCustomText('')
      customTextDirtyRef.current = false

      // Save cleared custom text + restore slider personality to SOUL.md
      void fetch('/api/personality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, values, customText: null }),
      }).catch(() => {})

      void (async () => {
        try {
          const existing = await readAgentFile(selectedAgentId, SOUL_FILE)
          baseSoulRef.current = stripPersonalityBlock(existing)
          const mergedContent = mergeSoulWithPersonality(baseSoulRef.current, values)
          await mutationQueue.enqueue(selectedAgentId, () =>
            writeAgentFile(selectedAgentId, SOUL_FILE, mergedContent),
          )
          useEditorStore.getState().triggerSoulRefresh()
        } catch {
          // Best-effort
        }
      })()
    } else {
      // Switching to custom mode
      setCustomMode(true)
    }
  }, [client, selectedAgentId, customMode, values])

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!selectedAgentId) {
    return (
      <div className="flex items-center justify-center py-8 text-[12px] text-foreground/45">
        Select an agent to configure its personality.
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-foreground/50">
        <Spinner size={15} />
        <span className="text-[12px]">Loading personality…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Sliders */}
      <div
        style={{
          opacity: customMode ? 0.3 : 1,
          pointerEvents: customMode ? 'none' : 'auto',
          transition: 'opacity 0.2s',
        }}
      >
        {DIMENSIONS.map((dim) => {
          const labels = SLIDER_LABELS[dim.key]
          return (
            <div key={dim.key} className="mb-6 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-foreground">{dim.label}</span>
                <span className="font-data min-w-[2.5rem] text-right text-[12px] text-foreground/55 tabular-nums">
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

              <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/40">
                <span>{labels.left}</span>
                <span>{labels.right}</span>
              </div>

              <p className="text-[11px] leading-relaxed text-foreground/60">
                {getDimensionText(dim.key, values[dim.key])}
              </p>
            </div>
          )
        })}
      </div>

      {/* Custom text override toggle */}
      <div className="border-t border-border pt-3">
        <Button
          variant={customMode ? 'primary' : 'secondary'}
          size="sm"
          fullWidth
          onClick={toggleMode}
          className="justify-start"
        >
          {customMode ? (
            <>
              <SlidersHorizontal size={13} strokeWidth={2} />
              Switch to Sliders
            </>
          ) : (
            <>
              <PenLine size={13} strokeWidth={2} />
              Use Custom Instructions
            </>
          )}
        </Button>

        {customMode && (
          <p className="mt-2 mb-2 text-[11px] leading-snug text-foreground/40">
            Write free-form personality instructions. This overrides the slider-generated
            personality in SOUL.md.
          </p>
        )}
      </div>

      {/* Custom text textarea (when in custom mode) */}
      {customMode && (
        <div>
          <textarea
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value)
              customTextDirtyRef.current = true
            }}
            onBlur={() => {
              if (customTextDirtyRef.current && customText.trim()) {
                saveCustomText(customText)
              }
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                if (customText.trim()) {
                  saveCustomText(customText)
                }
              }
            }}
            rows={8}
            placeholder="e.g. Be concise and direct. Use technical language when discussing code. Never use emojis. Always explain trade-offs when making recommendations."
            spellCheck={false}
            className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
            style={{ minHeight: 120 }}
          />
          <p className="mt-1.5 font-mono text-[10px] text-foreground/30">
            Saves on blur or {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S
          </p>
        </div>
      )}

      {/* Footer: preview toggle + save status */}
      <div className="flex items-center justify-between border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowPreview((p) => !p)}
          className="flex items-center gap-1.5 text-[11px] text-foreground/50 transition-colors hover:text-foreground/80 cursor-pointer"
        >
          <FileText className="h-3.5 w-3.5" strokeWidth={2} />
          {showPreview ? 'Hide' : 'Preview'} SOUL.md
        </button>

        <div className="flex items-center gap-2">
          {saving && (
            <span className="flex items-center gap-1.5 text-[11px] text-foreground/55">
              <Spinner size={12} />
              Saving…
            </span>
          )}
          {saved && !saving && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-mint">
              <Check size={12} strokeWidth={2.5} />
              Saved
            </span>
          )}
          {error && !saving && <span className="text-[11px] text-destructive">{error}</span>}
        </div>
      </div>

      {/* SOUL.md preview — shows merged content (role description + personality) */}
      {showPreview && (
        <div
          className="max-h-64 overflow-y-auto rounded-xl border border-border bg-surface p-3"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          <pre
            className="whitespace-pre-wrap text-[10px] leading-relaxed text-foreground/60"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {customMode && customText.trim()
              ? mergeSoulWithCustomPersonality(baseSoulRef.current, customText)
              : mergeSoulWithPersonality(baseSoulRef.current, values)}
          </pre>
        </div>
      )}
    </div>
  )
}
