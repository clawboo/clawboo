'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { Slider } from '@/components/ui/slider'

// ─── Types ────────────────────────────────────────────────────────────────────

type SliderKey = 'verbosity' | 'humor' | 'caution' | 'speed_cost' | 'formality'
type Values = Record<SliderKey, number>

interface Dimension {
  key: SliderKey
  label: string
  leftLabel: string
  rightLabel: string
  sectionText: (v: number) => string
}

// ─── Personality dimension definitions ────────────────────────────────────────
// Each dimension maps a 0–100 value to a descriptive SOUL.md section.

const DIMENSIONS: Dimension[] = [
  {
    key: 'verbosity',
    label: 'Verbosity',
    leftLabel: 'Terse',
    rightLabel: 'Verbose',
    sectionText: (v) => {
      if (v < 20)
        return 'Respond with the absolute minimum — single sentences where possible. No preamble, no summaries.'
      if (v < 40)
        return 'Keep responses brief and focused. Provide enough detail to be actionable, nothing more.'
      if (v < 60)
        return 'Balance brevity with clarity. Explain reasoning when it aids understanding, but avoid padding.'
      if (v < 80)
        return 'Provide thorough explanations with relevant examples and context. Cover the important nuances.'
      return 'Elaborate fully — explore edge cases, alternatives, and tradeoffs. Assume the reader wants depth.'
    },
  },
  {
    key: 'humor',
    label: 'Humor',
    leftLabel: 'Serious',
    rightLabel: 'Witty',
    sectionText: (v) => {
      if (v < 20)
        return 'Maintain a purely professional, no-nonsense tone. Focus on facts and substance.'
      if (v < 40) return 'Stay mostly professional but remain warm and approachable.'
      if (v < 60) return 'Be friendly and occasionally use light wit when it fits naturally.'
      if (v < 80) return 'Bring a playful energy — wordplay, light jokes, and banter are welcome.'
      return 'Lean into humor and creativity. Make it fun while still being genuinely helpful.'
    },
  },
  {
    key: 'caution',
    label: 'Caution',
    leftLabel: 'Bold',
    rightLabel: 'Careful',
    sectionText: (v) => {
      if (v < 20)
        return 'Act decisively with minimal caveats. Trust that the user knows what they want.'
      if (v < 40) return 'Proceed confidently but note any significant gotchas upfront.'
      if (v < 60)
        return 'Balance action with appropriate warnings. Flag risks without over-qualifying.'
      if (v < 80)
        return 'Highlight risks clearly. Prefer safe, reversible approaches and ask when uncertain.'
      return 'Treat every action as potentially consequential. Confirm before acting on anything irreversible.'
    },
  },
  {
    key: 'speed_cost',
    label: 'Speed vs Cost',
    leftLabel: 'Fast',
    rightLabel: 'Economical',
    sectionText: (v) => {
      if (v < 20)
        return 'Optimize for speed and capability. Use the most powerful model available without restraint.'
      if (v < 40)
        return "Lean toward speed. Use capable models and don't artificially constrain context."
      if (v < 60)
        return 'Balance speed and cost. Choose model and context proportionate to task complexity.'
      if (v < 80) return 'Prefer lighter models where quality allows. Keep context windows lean.'
      return 'Aggressively minimize costs. Use the smallest model that can handle the task.'
    },
  },
  {
    key: 'formality',
    label: 'Formality',
    leftLabel: 'Casual',
    rightLabel: 'Formal',
    sectionText: (v) => {
      if (v < 20)
        return "Communicate like you're chatting with a friend. Contractions, casual language, relaxed tone."
      if (v < 40) return 'Keep it conversational and warm, but stay focused and professional.'
      if (v < 60) return 'Friendly but professional. Clear and direct without being stiff.'
      if (v < 80)
        return 'Maintain a structured, professional tone. Complete sentences and proper grammar.'
      return 'Communicate with formal precision. Structured prose, no contractions, careful word choice.'
    },
  },
]

// ─── SOUL.md round-trip ───────────────────────────────────────────────────────
// Values are stored in a hidden HTML comment so they survive read→write round trips.
// Format: <!-- clawboo:personality verbosity=50 humor=50 caution=50 speed_cost=50 formality=50 -->

const SOUL_FILE = 'SOUL.md'
const META_RE = /<!--\s*clawboo:personality\s+([^>]+?)-->/

const DEFAULT_VALUES: Values = {
  verbosity: 50,
  humor: 50,
  caution: 50,
  speed_cost: 50,
  formality: 50,
}

const SLIDER_KEYS = Object.keys(DEFAULT_VALUES) as SliderKey[]

function parseValues(content: string): Values {
  const match = META_RE.exec(content)
  if (!match || !match[1]) return { ...DEFAULT_VALUES }

  const result: Values = { ...DEFAULT_VALUES }
  for (const pair of match[1].trim().split(/\s+/)) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx < 0) continue
    const k = pair.slice(0, eqIdx)
    const v = parseInt(pair.slice(eqIdx + 1), 10)
    if (k in result && !isNaN(v)) {
      result[k as SliderKey] = Math.max(0, Math.min(100, v))
    }
  }
  return result
}

function buildSoul(values: Values): string {
  const meta = SLIDER_KEYS.map((k) => `${k}=${values[k]}`).join(' ')
  const sections = DIMENSIONS.map((d) => `## ${d.label}\n${d.sectionText(values[d.key])}`).join(
    '\n\n',
  )
  return `# SOUL\n\n<!-- clawboo:personality ${meta} -->\n\n${sections}\n`
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PersonalitySliders() {
  const client = useConnectionStore((s) => s.client)
  const selectedAgentId = useFleetStore((s) => s.selectedAgentId)

  const [values, setValues] = useState<Values>({ ...DEFAULT_VALUES })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * dirtyRef tracks slider values that have been changed by the user but not yet
   * confirmed by the Gateway. It is set in handleChange and cleared after a
   * confirmed save (or on unmount flush-on-unmount).
   */
  const dirtyRef = useRef<Values | null>(null)

  // Load SOUL.md when selected agent changes.
  // The cleanup flushes any dirty (unsaved) state to the Gateway BEFORE unmounting,
  // so values are preserved even if the user switches agents before releasing the slider.
  useEffect(() => {
    if (!client || !selectedAgentId) return
    // NOTE: no clearTimeout here — the cleanup return below handles cancellation
    //       and immediately fires the pending save before the component unmounts.

    setLoading(true)
    setError(null)
    setValues({ ...DEFAULT_VALUES })

    client.agents.files
      .read(selectedAgentId, SOUL_FILE)
      .then((content) => setValues(parseValues(content)))
      .catch(() => {
        // File doesn't exist yet — defaults are already set
      })
      .finally(() => setLoading(false))

    return () => {
      // Flush any pending save for THIS agent before unmounting.
      // key={selectedAgentId} in FleetSidebar guarantees the component unmounts on every
      // agent switch, so the stale closure values here are always the LEAVING agent's.
      if (savedTimer.current) {
        clearTimeout(savedTimer.current)
        savedTimer.current = null
      }
      const dirty = dirtyRef.current
      if (dirty) {
        dirtyRef.current = null
        void client.agents.files.set(selectedAgentId, SOUL_FILE, buildSoul(dirty)).catch(() => {}) // best-effort; silent on switch
      }
    }
  }, [client, selectedAgentId])

  // handleChange: updates local state + marks dirty (no Gateway call).
  // The live description text re-renders from `values` state.
  const handleChange = useCallback((key: SliderKey, value: number) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value }
      dirtyRef.current = next // mark as dirty so flush-on-unmount picks it up
      return next
    })
  }, [])

  // handleCommit: fires on pointer-up and keyboard commit (onValueCommit from Radix).
  // Saves immediately to the Gateway — no debounce needed.
  const handleCommit = useCallback(
    (key: SliderKey, value: number) => {
      if (!client || !selectedAgentId) return
      const next = { ...values, [key]: value }
      setValues(next)
      dirtyRef.current = null // about to save — mark clean optimistically

      if (savedTimer.current) clearTimeout(savedTimer.current)
      setSaved(false)
      setSaving(true)
      setError(null)

      client.agents.files
        .set(selectedAgentId, SOUL_FILE, buildSoul(next))
        .then(() => {
          setSaved(true)
          savedTimer.current = setTimeout(() => setSaved(false), 2000)
        })
        .catch((err: unknown) => {
          dirtyRef.current = next // restore dirty so cleanup can retry
          setError(err instanceof Error ? err.message : 'Save failed')
        })
        .finally(() => setSaving(false))
    },
    [client, selectedAgentId, values],
  )

  // ─── Render ───────────────────────────────────────────────────────────────

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
        <span className="text-[12px]">Loading SOUL.md…</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Sliders */}
      {DIMENSIONS.map((dim) => (
        <div key={dim.key} className="space-y-2">
          {/* Label + numeric value */}
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

          {/* shadcn/ui Slider — onValueChange for live description, onValueCommit to save */}
          <Slider
            value={[values[dim.key]]}
            min={0}
            max={100}
            step={1}
            onValueChange={(vals) => handleChange(dim.key, vals[0] ?? 50)}
            onValueCommit={(vals) => handleCommit(dim.key, vals[0] ?? 50)}
          />

          {/* Min / max endpoint labels */}
          <div className="flex justify-between">
            <span className="text-[10px] text-secondary/50">{dim.leftLabel}</span>
            <span className="text-[10px] text-secondary/50">{dim.rightLabel}</span>
          </div>

          {/* Live description — updates as the slider moves */}
          <p className="text-[11px] leading-relaxed text-secondary/70">
            {dim.sectionText(values[dim.key])}
          </p>
        </div>
      ))}

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

      {/* SOUL.md preview panel */}
      {showPreview && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-white/8 bg-surface p-3">
          <pre
            className="whitespace-pre-wrap text-[10px] leading-relaxed text-secondary/70"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {buildSoul(values)}
          </pre>
        </div>
      )}
    </div>
  )
}
