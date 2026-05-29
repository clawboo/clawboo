/**
 * TemplateFanDeck — Phase 16 signature element.
 *
 * Replaces the vertical pick-list in CreateTeamModal with a fanned card deck
 * (Mercury-style). 5 cards visible at once: a centred focused card flanked by
 * pairs of rotated cards on each side. Click a side card to refocus it; click
 * the focused card (or press Enter) to commit the selection.
 *
 * Pure Framer Motion — no new deps beyond what's already in the app.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Info } from 'lucide-react'
import type { TeamTemplate } from './types'
import { SOURCE_META, resolveTeamAgents } from '@/features/marketplace/teamCatalog'

const HERO_W = 220
const HERO_H = 300
const SIDE_OFFSET_1 = 130
const SIDE_OFFSET_2 = 230
const SIDE_ROT_1 = 11
const SIDE_ROT_2 = 22

export interface TemplateFanDeckProps {
  templates: TeamTemplate[]
  onPick: (template: TeamTemplate) => void
  onShowDetails: (template: TeamTemplate) => void
}

export function TemplateFanDeck({ templates, onPick, onShowDetails }: TemplateFanDeckProps) {
  const [focused, setFocused] = useState(0)

  // Keep focus in range when the filtered set changes (e.g. user typed in search).
  useEffect(() => {
    if (focused >= templates.length) setFocused(0)
  }, [templates.length, focused])

  const cycle = useCallback(
    (delta: 1 | -1) => {
      if (templates.length === 0) return
      setFocused((f) => (f + delta + templates.length) % templates.length)
    },
    [templates.length],
  )

  // Keyboard navigation: ← → cycle, Enter selects, no preventDefault on others
  // so search input keystrokes still flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        cycle(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        cycle(1)
      } else if (e.key === 'Enter' && templates[focused]) {
        e.preventDefault()
        onPick(templates[focused])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycle, focused, templates, onPick])

  // Compute which 5 indices are visible (focused, ±1, ±2). Wrap-around if the
  // deck has more than 4 templates; otherwise just show what we have.
  const visible = useMemo(() => {
    const slots: Array<{ index: number; offset: -2 | -1 | 0 | 1 | 2 }> = []
    if (templates.length === 0) return slots
    const n = templates.length
    const offsets: Array<-2 | -1 | 0 | 1 | 2> = [-2, -1, 0, 1, 2]
    for (const offset of offsets) {
      if (n === 1 && offset !== 0) continue
      if (n === 2 && (offset === -2 || offset === 2)) continue
      if (n === 3 && (offset === -2 || offset === 2)) continue
      if (n === 4 && offset === -2) continue
      const idx = (((focused + offset) % n) + n) % n
      slots.push({ index: idx, offset })
    }
    return slots
  }, [templates.length, focused])

  if (templates.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[12px] text-secondary/40"
        style={{ height: HERO_H + 60 }}
      >
        No templates match your search.
      </div>
    )
  }

  return (
    <div
      className="relative mt-2"
      style={{ height: HERO_H + 60 /* room for side-arrow click targets */ }}
    >
      {/* Side-arrow buttons */}
      <button
        type="button"
        onClick={() => cycle(-1)}
        aria-label="Previous template"
        className="surface-floating-tier absolute left-1 top-1/2 z-50 -translate-y-1/2 rounded-full p-1.5 text-secondary/60 transition hover:text-text"
        style={{
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ChevronLeft style={{ width: 16, height: 16 }} strokeWidth={2.4} />
      </button>
      <button
        type="button"
        onClick={() => cycle(1)}
        aria-label="Next template"
        className="surface-floating-tier absolute right-1 top-1/2 z-50 -translate-y-1/2 rounded-full p-1.5 text-secondary/60 transition hover:text-text"
        style={{
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ChevronRight style={{ width: 16, height: 16 }} strokeWidth={2.4} />
      </button>

      {/* Fan stage — masked at the horizontal edges so outer fan cards
          gracefully fade into the modal walls instead of clipping abruptly.
          The mask spares the bottom (where dots / pagination indicator lives)
          and the centre 80% of horizontal width (where the focused + ±1 cards
          live in full opacity). */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          perspective: 1200,
          WebkitMaskImage:
            'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)',
          maskImage:
            'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)',
        }}
      >
        <AnimatePresence initial={false}>
          {visible.map(({ index, offset }) => {
            const template = templates[index]
            if (!template) return null
            const isFocused = offset === 0
            const x =
              offset === -2
                ? -SIDE_OFFSET_2
                : offset === -1
                  ? -SIDE_OFFSET_1
                  : offset === 1
                    ? SIDE_OFFSET_1
                    : offset === 2
                      ? SIDE_OFFSET_2
                      : 0
            const rot =
              offset === -2
                ? -SIDE_ROT_2
                : offset === -1
                  ? -SIDE_ROT_1
                  : offset === 1
                    ? SIDE_ROT_1
                    : offset === 2
                      ? SIDE_ROT_2
                      : 0
            const scale = isFocused ? 1 : offset === -1 || offset === 1 ? 0.86 : 0.72
            const opacity = isFocused ? 1 : offset === -1 || offset === 1 ? 0.7 : 0.4
            const z = isFocused ? 30 : offset === -1 || offset === 1 ? 20 : 10

            return (
              <motion.div
                key={`${template.id}-${index}`}
                initial={{ x, rotateZ: rot, scale: scale * 0.94, opacity: opacity * 0.5 }}
                animate={{ x, rotateZ: rot, scale, opacity, zIndex: z }}
                exit={{ x, rotateZ: rot, scale: scale * 0.94, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                style={{
                  position: 'absolute',
                  width: HERO_W,
                  height: HERO_H,
                  transformOrigin: 'center bottom',
                }}
                onClick={() => {
                  if (isFocused) onPick(template)
                  else setFocused(index)
                }}
                role="button"
                tabIndex={isFocused ? 0 : -1}
                aria-label={isFocused ? `Pick ${template.name}` : `Focus ${template.name}`}
              >
                <FanCard template={template} isFocused={isFocused} onShowDetails={onShowDetails} />
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* Pagination indicator — compact for large catalogs.
          ≤ 12 templates: dot row (visual rhythm at small counts).
          > 12: "N / Total" mono indicator + tap-anywhere on the indicator
          row to focus a card without dragging across 80+ dots. */}
      <div
        className="absolute bottom-0 left-1/2 flex -translate-x-1/2 items-center gap-1.5"
        style={{ height: 18 }}
      >
        {templates.length <= 12 ? (
          templates.map((t, i) => (
            <button
              key={t.id}
              type="button"
              aria-label={`Focus ${t.name}`}
              onClick={() => setFocused(i)}
              style={{
                width: i === focused ? 14 : 6,
                height: 6,
                borderRadius: 999,
                background:
                  i === focused ? 'var(--foreground)' : 'rgb(var(--foreground-rgb) / 0.2)',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                transition: 'width var(--motion-fast), background var(--motion-fast)',
              }}
            />
          ))
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.06em',
              color: 'rgb(var(--foreground-rgb) / 0.55)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {focused + 1} / {templates.length}
          </span>
        )}
      </div>
    </div>
  )
}

interface FanCardProps {
  template: TeamTemplate
  isFocused: boolean
  onShowDetails: (template: TeamTemplate) => void
}

function FanCard({ template, isFocused, onShowDetails }: FanCardProps) {
  const srcMeta = SOURCE_META[template.source]
  const agentCount = resolveTeamAgents(template).length

  return (
    <div
      className="relative flex h-full w-full flex-col items-center gap-3 overflow-hidden rounded-2xl p-5 text-center"
      style={{
        // SOLID card — Mercury-style. Brand color lives in the edge accents
        // (border + 2px top band + focused-card shadow halo), never in the
        // body. This keeps the card legible against the modal's dark backdrop
        // without the glass tier washing it out.
        background: 'var(--surface-raised)',
        border: `1px solid ${isFocused ? `${template.color}55` : `${template.color}28`}`,
        boxShadow: isFocused
          ? `0 28px 70px ${template.color}55, 0 12px 28px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 / 0.3)`
          : '0 10px 28px rgb(0 0 0 / 0.35), 0 2px 6px rgb(0 0 0 / 0.25)',
        transition: 'box-shadow var(--motion-base), border-color var(--motion-base)',
      }}
    >
      {/* 2px accent band at the very top — the only place the brand color
          touches the card body. Reads as a colored card stripe. */}
      <div
        aria-hidden
        className="absolute left-0 right-0 top-0"
        style={{
          height: 3,
          background: template.color,
          opacity: isFocused ? 1 : 0.6,
          transition: 'opacity var(--motion-base)',
        }}
      />
      {/* Source pill (top-right) */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          background: `${srcMeta.color}24`,
          border: `1px solid ${srcMeta.color}40`,
          color: srcMeta.color,
          borderRadius: 6,
          padding: '1px 6px',
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
        }}
      >
        {srcMeta.label}
      </div>

      {/* Info icon (only on focused card) */}
      {isFocused && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onShowDetails(template)
          }}
          aria-label={`Show details for ${template.name}`}
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            background: 'transparent',
            border: 'none',
            padding: 4,
            cursor: 'pointer',
            color: 'rgb(var(--foreground-rgb) / 0.5)',
            display: 'flex',
            transition: 'color var(--motion-fast)',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--foreground)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgb(var(--foreground-rgb) / 0.5)'
          }}
        >
          <Info style={{ width: 14, height: 14 }} strokeWidth={2.2} />
        </button>
      )}

      {/* Emoji crest */}
      <div
        className="mt-6 flex items-center justify-center rounded-2xl"
        style={{
          width: 64,
          height: 64,
          background: `${template.color}22`,
          border: `1px solid ${template.color}40`,
          fontSize: 32,
          boxShadow: isFocused ? `0 6px 18px ${template.color}30` : '0 2px 8px rgb(0 0 0 / 0.25)',
          transition: 'box-shadow var(--motion-base)',
        }}
      >
        {template.emoji}
      </div>

      {/* Name */}
      <div
        className="px-2 text-text"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          lineHeight: 1.2,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {template.name}
      </div>

      {/* Agent count */}
      <div
        className="text-[10px] uppercase tracking-widest text-secondary/55"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
      </div>

      {/* Description (focused only) */}
      {isFocused && (
        <p
          className="mt-1 px-1 text-[11px] leading-relaxed text-secondary/65"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {template.description}
        </p>
      )}

      {/* CTA hint (focused only) */}
      {isFocused && (
        <div
          className="mt-auto rounded-lg text-[11px] font-semibold"
          style={{
            color: template.color,
            background: `${template.color}1a`,
            border: `1px solid ${template.color}45`,
            padding: '5px 14px',
          }}
        >
          Press Enter to pick
        </div>
      )}
    </div>
  )
}
