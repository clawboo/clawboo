/**
 * Team emoji-icon picker — a trigger button showing the current icon that opens
 * a searchable, category-sectioned emoji grid (from the curated `emojiCatalog`).
 * No emoji-library dependency. A "Custom" field lets users paste any emoji that
 * isn't in the catalog.
 *
 * The popover renders through a portal to `document.body` with FIXED positioning
 * anchored to the trigger — same load-bearing pattern as `ModelDropdown`: this
 * picker lives inside overlay modals (CreateTeamModal / TeamSettingsSheet) that
 * clip overflow, so an in-flow absolute menu would be cut off. We flip the menu
 * ABOVE the trigger when there's no room below and reposition on scroll/resize.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil } from 'lucide-react'

import { EMOJI_CATEGORIES, searchEmojis, type EmojiEntry } from './emojiCatalog'

interface TeamIconPickerProps {
  value: string
  onChange: (emoji: string) => void
  /**
   * When set, the trigger renders as the team badge — the icon on this accent
   * color's tint — so it doubles as the live badge preview (no separate chip).
   */
  accentColor?: string
}

interface MenuPos {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

const MENU_W = 288
const MENU_DESIRED_HEIGHT = 340
const MENU_GAP = 6

function EmojiGrid({
  emojis,
  value,
  onPick,
}: {
  emojis: EmojiEntry[]
  value: string
  onPick: (emoji: string) => void
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
      {emojis.map((e) => (
        <button
          key={e.c}
          type="button"
          title={e.n}
          aria-label={e.n}
          onClick={() => onPick(e.c)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[16px] leading-none transition-colors hover:bg-foreground/[0.08]"
          style={{ boxShadow: value === e.c ? 'inset 0 0 0 2px var(--primary)' : 'none' }}
        >
          {e.c}
        </button>
      ))}
    </div>
  )
}

export function TeamIconPicker({ value, onChange, accentColor }: TeamIconPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<MenuPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const computePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < MENU_DESIRED_HEIGHT + MENU_GAP + 8 && spaceAbove > spaceBelow
    const maxHeight = Math.max(
      200,
      Math.min(MENU_DESIRED_HEIGHT, (openUp ? spaceAbove : spaceBelow) - 12),
    )
    const left = Math.min(Math.max(8, r.left), window.innerWidth - MENU_W - 8)
    setPos({
      left,
      maxHeight,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + MENU_GAP }
        : { top: r.bottom + MENU_GAP }),
    })
  }, [])

  useLayoutEffect(() => {
    if (open) computePosition()
  }, [open, computePosition])

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    const focusId = window.setTimeout(() => searchRef.current?.focus(), 0)
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onReflow = () => computePosition()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      window.clearTimeout(focusId)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, computePosition])

  const choose = useCallback(
    (emoji: string) => {
      onChange(emoji)
      setOpen(false)
    },
    [onChange],
  )

  const results = query.trim() ? searchEmojis(query) : null

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Change team icon"
        title="Change icon"
        onClick={() => setOpen((v) => !v)}
        className={`relative flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl text-2xl outline-none transition-all focus:ring-1 focus:ring-ring/30 ${
          accentColor
            ? 'hover:brightness-95'
            : 'border border-border bg-foreground/[0.03] hover:border-foreground/20'
        }`}
        style={
          accentColor
            ? { backgroundColor: `${accentColor}22`, border: `1px solid ${accentColor}33` }
            : undefined
        }
      >
        {value || '🙂'}
        {/* Edit affordance — makes it obvious the badge is clickable to change */}
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-1 -right-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background"
          style={{ border: '2px solid var(--surface)' }}
        >
          <Pencil className="h-2 w-2" strokeWidth={2.5} />
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Team icon picker"
            className="surface-floating-tier"
            style={{
              position: 'fixed',
              left: pos.left,
              width: MENU_W,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
              zIndex: 1000,
              maxHeight: pos.maxHeight,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            {/* Search */}
            <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search emoji…"
                className="w-full rounded-md border border-border bg-foreground/[0.03] px-2.5 py-1.5 text-[12px] text-foreground outline-none placeholder:text-secondary/50 focus:border-foreground/20"
              />
            </div>

            {/* Grid */}
            <div style={{ overflowY: 'auto', padding: 8, flex: 1 }}>
              {results ? (
                results.length === 0 ? (
                  <p className="px-1 py-6 text-center text-[11px] text-secondary/60">
                    No emoji found — paste your own below.
                  </p>
                ) : (
                  <EmojiGrid emojis={results} value={value} onPick={choose} />
                )
              ) : (
                EMOJI_CATEGORIES.map((cat) => (
                  <div key={cat.id} style={{ marginBottom: 8 }}>
                    <div className="mb-1 px-0.5 text-[10px] font-medium uppercase tracking-wider text-secondary/60">
                      {cat.label}
                    </div>
                    <EmojiGrid emojis={cat.emojis} value={value} onPick={choose} />
                  </div>
                ))
              )}
            </div>

            {/* Custom paste — anything not in the catalog */}
            <div
              className="flex items-center gap-2"
              style={{ padding: 8, borderTop: '1px solid var(--border)' }}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-secondary/60">
                Custom
              </span>
              <input
                type="text"
                maxLength={8}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v) onChange(v)
                }}
                placeholder="Paste any emoji"
                className="min-w-0 flex-1 rounded-md border border-border bg-foreground/[0.03] px-2 py-1 text-center text-[14px] outline-none placeholder:text-[11px] placeholder:text-secondary/50 focus:border-foreground/20"
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
