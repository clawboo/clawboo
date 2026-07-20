// A two-LAYER model picker for the team-create roster: pick a PROVIDER first
// (left column — only the ones actually connected), then its MODEL (right column,
// revealed on hover/click). This replaces the old flat single-column list where
// OpenClaw's hundreds of live OpenRouter models drowned every other provider.
//
// Trigger transparency: instead of an opaque "Recommended", the trigger shows the
// EXACT model that will run when nothing is explicitly picked — the runtime's
// resolved default (passed as `defaultModelId`), rendered as "Default · <model>".
// An explicit pick shows just the model label. The underlying value stays `''`
// for "follow the default" (deploy semantics unchanged — no model is forced),
// so the display is informative, not a hidden pin.
//
// Rendered through a body portal with fixed positioning (escapes the modal's
// overflow/clipping), flips above when there's no room below. The right column
// gains a scoped search box for a long provider list (e.g. live OpenRouter).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'

import { ProviderIcon, type ProviderId } from '@/features/onboarding/ProviderIcon'
import { providerSlug } from '@/lib/modelCatalog'
import { SearchInput } from '@/features/shared/SearchInput'

export interface ModelPickerGroup {
  /** Provider display name, e.g. "Anthropic", "OpenAI Codex". */
  provider: string
  models: { id: string; label: string }[]
}

export interface MemberModelSelectProps {
  /** The picked model id, or '' to follow the runtime's default. */
  value: string
  onChange: (id: string) => void
  /** Provider groups — ALREADY filtered to the connected providers. */
  groups: ModelPickerGroup[]
  /** The model that actually runs when `value` is '' (the runtime's resolved
   *  default) — shown transparently in the trigger as "Default · <label>".
   *  Null when it can't be resolved client-side (then the trigger reads "Default"). */
  defaultModelId?: string | null
  /** The provider the default belongs to — used to pre-select the right provider
   *  column when the default id isn't an exact/prefixed catalog match (e.g. a
   *  native bare model id whose provider can't be inferred from the id alone). */
  defaultProvider?: string | null
  className?: string
  style?: CSSProperties
  'data-testid'?: string
  'aria-label'?: string
}

const MENU_LEFT_W = 148
const MENU_RIGHT_W = 224
const MENU_W = MENU_LEFT_W + MENU_RIGHT_W
const MENU_MAX_H = 300
const MENU_GAP = 4
const SEARCH_THRESHOLD = 9

/** Map a provider display name → the brand-icon id (best-effort; unknown → null). */
function providerIconId(provider: string): ProviderId | null {
  const slug = providerSlug(provider)
  const MAP: Record<string, ProviderId> = {
    anthropic: 'anthropic',
    openai: 'openai',
    openaicodex: 'openai-codex',
    openrouter: 'openrouter',
    google: 'google',
    xai: 'xai',
    groq: 'groq',
    mistral: 'mistral',
    together: 'together',
    cerebras: 'cerebras',
    moonshot: 'moonshot',
    minimax: 'minimax',
    nvidia: 'nvidia',
    huggingface: 'huggingface',
    venice: 'venice',
    ollama: 'ollama',
  }
  return MAP[slug] ?? null
}

/** Find a model (and its provider) by id across the groups. */
function findModel(
  groups: ModelPickerGroup[],
  id: string,
): { label: string; provider: string } | null {
  for (const g of groups) {
    const m = g.models.find((x) => x.id === id)
    if (m) return { label: m.label, provider: g.provider }
  }
  return null
}

/** A readable label for a model id NOT in the catalog (e.g. the Gateway default,
 *  whose routing id may not exactly match the live list) — its last path segment,
 *  so the trigger stays transparent ("Default · claude-sonnet-4-5") rather than a
 *  bare "Default". */
function fallbackModelLabel(id: string): string {
  const seg = id.split('/').pop() ?? id
  return seg.trim()
}

/** The provider (group) a model id BELONGS to — so the dropdown pre-selects the
 *  right provider column for the current model. Exact catalog match first; else
 *  infer from the id's LEADING routing token — critical for OpenClaw ids like
 *  `openrouter/anthropic/claude-sonnet-4-5` (a Claude model routed THROUGH
 *  OpenRouter → its provider is OpenRouter, not Anthropic and not the first
 *  group). Returns null when neither resolves. */
function resolveProviderName(
  groups: ModelPickerGroup[],
  id: string,
  fallbackProvider?: string | null,
): string | null {
  if (!id && !fallbackProvider) return null
  const exact = id ? findModel(groups, id) : null
  if (exact) return exact.provider
  const lead = id.split('/')[0] ?? ''
  const byPrefix = lead ? groups.find((g) => providerSlug(g.provider) === providerSlug(lead)) : null
  if (byPrefix) return byPrefix.provider
  if (fallbackProvider) {
    const byFallback = groups.find(
      (g) => providerSlug(g.provider) === providerSlug(fallbackProvider),
    )
    if (byFallback) return byFallback.provider
  }
  return null
}

interface MenuPos {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function MemberModelSelect({
  value,
  onChange,
  groups,
  defaultModelId,
  defaultProvider,
  className,
  style,
  'data-testid': dataTestId,
  'aria-label': ariaLabel,
}: MemberModelSelectProps) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState<MenuPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Trigger label — transparent about the default (never "Recommended"). When the
  // default id isn't in the (connected-filtered) catalog, fall back to its readable
  // tail so the exact model still shows.
  const picked = value ? findModel(groups, value) : null
  const defaultModel = defaultModelId ? findModel(groups, defaultModelId) : null
  const defaultLabel =
    defaultModel?.label ?? (defaultModelId ? fallbackModelLabel(defaultModelId) : null)
  const triggerLabel = picked ? (
    picked.label
  ) : (
    <span>
      <span style={{ color: 'rgb(var(--foreground-rgb) / 0.5)' }}>Default</span>
      {defaultLabel ? ` · ${defaultLabel}` : ''}
    </span>
  )

  // The provider whose column is shown on open — the provider the CURRENT model
  // (pick, else default) actually belongs to, so the highlighted column always
  // matches the trigger (never "Codex highlighted while the model is a Claude
  // routed via OpenRouter"). Resolves through exact match → id prefix → the
  // explicit defaultProvider fallback.
  const seedProvider = useMemo(() => {
    if (value) {
      const p = resolveProviderName(groups, value)
      if (p) return p
    }
    if (defaultModelId) {
      const p = resolveProviderName(groups, defaultModelId, defaultProvider)
      if (p) return p
    }
    return groups[0]?.provider ?? null
  }, [value, defaultModelId, defaultProvider, groups])

  // The effective current model — the pick, or the default when unset — so the
  // right column check-marks whatever the trigger shows (clarity on open).
  const currentModelId = value || defaultModelId || ''

  const activeGroup = useMemo(
    () => groups.find((g) => g.provider === (activeProvider ?? seedProvider)) ?? groups[0] ?? null,
    [groups, activeProvider, seedProvider],
  )

  const searchable = (activeGroup?.models.length ?? 0) > SEARCH_THRESHOLD
  const shownModels = useMemo(() => {
    const list = activeGroup?.models ?? []
    const q = searchable ? search.trim().toLowerCase() : ''
    if (!q) return list
    return list.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
  }, [activeGroup, search, searchable])

  const computePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < MENU_MAX_H + MENU_GAP + 8 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(MENU_MAX_H, (openUp ? spaceAbove : spaceBelow) - 12))
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - MENU_W))
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

  // Reset the transient menu state each time it opens: seed the active provider,
  // clear the search.
  useEffect(() => {
    if (open) {
      setActiveProvider(seedProvider)
      setSearch('')
    }
  }, [open, seedProvider])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const onReflow = () => computePosition()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, computePosition])

  const choose = useCallback(
    (id: string) => {
      onChange(id)
      setOpen(false)
    },
    [onChange],
  )

  const chevron = (
    <ChevronDown
      aria-hidden
      size={12}
      strokeWidth={2}
      style={{
        flexShrink: 0,
        color: 'rgb(var(--foreground-rgb) / 0.5)',
        transform: open ? 'rotate(180deg)' : 'none',
        transition: 'transform var(--motion-fast)',
      }}
    />
  )

  return (
    <div className={className} style={{ position: 'relative', display: 'inline-block', ...style }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          width: '100%',
          height: 26,
          paddingLeft: 8,
          paddingRight: 6,
          background: 'var(--surface)',
          border: `1px solid ${open || focused ? 'var(--primary)' : 'var(--border)'}`,
          borderRadius: 8,
          color: 'rgb(var(--foreground-rgb) / 0.85)',
          fontSize: 11,
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
          textAlign: 'left',
          cursor: 'pointer',
          outline: 'none',
          boxShadow: open || focused ? '0 0 0 4px rgb(var(--primary-rgb) / 0.15)' : 'none',
          transition:
            'border-color var(--motion-fast), background var(--motion-fast), box-shadow var(--motion-fast)',
          minWidth: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {triggerLabel}
        </span>
        {chevron}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="border border-border bg-popover"
            style={{
              position: 'fixed',
              left: pos.left,
              width: MENU_W,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
              zIndex: 1000,
              maxHeight: pos.maxHeight,
              borderRadius: 10,
              boxShadow: 'var(--shadow-floating)',
              display: 'flex',
              overflow: 'hidden',
            }}
          >
            {/* Left column — connected providers. */}
            <div
              role="menu"
              aria-label={ariaLabel ? `${ariaLabel} — provider` : 'Provider'}
              style={{
                width: MENU_LEFT_W,
                flexShrink: 0,
                borderRight: '1px solid var(--border)',
                overflowY: 'auto',
                padding: '5px 0',
              }}
            >
              {groups.length === 0 ? (
                <div
                  style={{
                    padding: '9px 12px',
                    fontSize: 11,
                    color: 'rgb(var(--foreground-rgb) / 0.45)',
                  }}
                >
                  No providers
                </div>
              ) : (
                groups.map((g) => {
                  const isActive = g.provider === activeGroup?.provider
                  const iconId = providerIconId(g.provider)
                  return (
                    <button
                      key={g.provider}
                      type="button"
                      role="menuitem"
                      aria-haspopup="true"
                      data-testid={`model-provider-${providerSlug(g.provider)}`}
                      onMouseEnter={() => {
                        setActiveProvider(g.provider)
                        setSearch('')
                      }}
                      onFocus={() => setActiveProvider(g.provider)}
                      onClick={() => {
                        setActiveProvider(g.provider)
                        setSearch('')
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        width: '100%',
                        padding: '7px 8px 7px 10px',
                        fontSize: 11.5,
                        fontFamily: 'var(--font-body)',
                        textAlign: 'left',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--foreground)',
                        background: isActive ? 'rgb(var(--foreground-rgb) / 0.06)' : 'transparent',
                        transition: 'background var(--motion-fast)',
                      }}
                    >
                      {iconId ? (
                        <ProviderIcon id={iconId} size={14} />
                      ) : (
                        <span style={{ width: 14, flexShrink: 0 }} />
                      )}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontWeight: isActive ? 600 : 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {g.provider}
                      </span>
                      <ChevronRight
                        aria-hidden
                        size={12}
                        strokeWidth={2}
                        style={{ flexShrink: 0, color: 'rgb(var(--foreground-rgb) / 0.4)' }}
                      />
                    </button>
                  )
                })
              )}
            </div>

            {/* Right column — the active provider's models. */}
            <div
              role="listbox"
              aria-label={ariaLabel ? `${ariaLabel} — model` : 'Model'}
              style={{
                width: MENU_RIGHT_W,
                flexShrink: 0,
                overflowY: 'auto',
                padding: '5px 0',
              }}
            >
              {searchable && (
                <div
                  className="bg-popover"
                  style={{ position: 'sticky', top: 0, zIndex: 1, padding: '2px 8px 6px' }}
                >
                  <SearchInput
                    size="sm"
                    value={search}
                    onChange={setSearch}
                    placeholder="Search models…"
                    aria-label="Search models"
                  />
                </div>
              )}
              {shownModels.length === 0 ? (
                <div
                  style={{
                    padding: '9px 12px',
                    fontSize: 11,
                    color: 'rgb(var(--foreground-rgb) / 0.45)',
                  }}
                >
                  No matches
                </div>
              ) : (
                shownModels.map((m) => {
                  // Highlight the effective current model — the pick, or the
                  // default when unset — so the open menu matches the trigger.
                  const isSelected = m.id === currentModelId
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => choose(m.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '7px 12px',
                        fontSize: 11.5,
                        fontFamily: 'var(--font-body)',
                        textAlign: 'left',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--foreground)',
                        background: isSelected ? 'rgb(var(--primary-rgb) / 0.07)' : 'transparent',
                        transition: 'background var(--motion-fast)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.06)'
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontWeight: isSelected ? 600 : 400,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {m.label}
                      </span>
                      {isSelected && (
                        <Check
                          style={{ width: 14, height: 14, color: 'var(--primary)', flexShrink: 0 }}
                        />
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
