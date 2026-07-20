import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/features/shared/Button'
import { SearchInput } from '@/features/shared/SearchInput'
import { findModelLabel, formatProviderName, providerSlug } from '@/lib/modelCatalog'
import { useModelCatalog } from '@/lib/useModelCatalog'

// ─── Component ───────────────────────────────────────────────────────────────

interface ModelSelectorProps {
  currentModel: string | null
  onModelChange: (model: string) => void
}

const LOCAL_PROVIDERS = new Set(['ollama', 'sglang', 'opencode', 'opencode-go'])

// The two-column menu (provider list + model list) is wider + taller than the
// narrow trigger pill. Anchor a FIXED, portaled popover to the trigger and flip
// it up when it won't fit below — the mechanics ModelDropdown / the shared Select
// use, load-bearing here because this picker now lives inside the Settings modal
// (a `.surface-overlay-tier` with backdrop-filter + overflow-hidden) nested in the
// OpenClaw runtime card; an in-flow `position:absolute` menu was clipped to a
// sliver and unreadable.
const MENU_MAX_HEIGHT = 420
const MENU_GAP = 4
const MENU_EST_WIDTH = 430

interface MenuPos {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const { groups: MODEL_GROUPS, configuredProviders } = useModelCatalog()
  const [open, setOpen] = useState(false)
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Anchor the fixed popover to the trigger; flip up only when it won't fit below.
  const computePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < MENU_MAX_HEIGHT + MENU_GAP + 8 && spaceAbove > spaceBelow
    const maxHeight = Math.max(
      180,
      Math.min(MENU_MAX_HEIGHT, (openUp ? spaceAbove : spaceBelow) - 12),
    )
    // Clamp left so the two-column menu never runs off the right edge.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_EST_WIDTH - 8))
    setPos({
      left,
      maxHeight,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + MENU_GAP }
        : { top: r.bottom + MENU_GAP }),
    })
  }, [])

  // Position synchronously before paint when opening to avoid a flash.
  useLayoutEffect(() => {
    if (open) computePosition()
  }, [open, computePosition])

  // Close on outside click / Escape; reposition on scroll (capture, to catch the
  // modal's inner scroller) / resize.
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture + stopPropagation so Esc closes THIS dropdown, not the parent
        // Settings modal whose own document-level Esc handler would also fire.
        e.stopPropagation()
        e.preventDefault()
        setOpen(false)
      }
    }
    const onReflow = () => computePosition()
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, computePosition])

  // Reset transient state when opening.
  useEffect(() => {
    if (open) {
      setSearch('')
      setCustomInput('')
      setShowCustom(false)
      setHoveredProvider(null)
    }
  }, [open])

  const handleSelect = useCallback(
    (modelId: string) => {
      onModelChange(modelId)
      setOpen(false)
    },
    [onModelChange],
  )

  const handleCustomSubmit = useCallback(() => {
    const trimmed = customInput.trim()
    if (trimmed && trimmed.includes('/')) {
      onModelChange(trimmed)
      setOpen(false)
    }
  }, [customInput, onModelChange])

  // Filter groups by search
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return MODEL_GROUPS
    const q = search.toLowerCase()
    return MODEL_GROUPS.map((group) => ({
      ...group,
      models: group.models.filter(
        (m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
      ),
    })).filter((group) => group.provider.toLowerCase().includes(q) || group.models.length > 0)
  }, [search, MODEL_GROUPS])

  // Determine if current model is custom (not in catalog)
  const isCustomModel = currentModel !== null && findModelLabel(currentModel) === null

  const displayLabel = currentModel ? (findModelLabel(currentModel) ?? currentModel) : 'Not set'

  // Slug-based comparison so display names ('OpenAI Codex') match the ids the
  // server reports as configured ('openai-codex' from the ChatGPT-subscription
  // oauth profile, 'huggingface' vs 'Hugging Face', …) — a bare .toLowerCase()
  // mismatches on the space/hyphen and greyed the keyless-but-connected Codex
  // subscription as "No key".
  const configuredSlugs = useMemo(
    () => new Set([...configuredProviders].map((p) => providerSlug(p))),
    [configuredProviders],
  )
  const isProviderConfigured = useCallback(
    (provider: string) => {
      if (configuredSlugs.size === 0) return true // No data yet — don't grey out
      if (LOCAL_PROVIDERS.has(provider.toLowerCase())) return true
      return configuredSlugs.has(providerSlug(provider))
    },
    [configuredSlugs],
  )

  // Get active Level 2 group
  const activeGroup = hoveredProvider
    ? filteredGroups.find((g) => g.provider === hoveredProvider)
    : null
  const activeGroupConfigured = activeGroup ? isProviderConfigured(activeGroup.provider) : true

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger pill */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 12px',
          fontSize: 12,
          fontWeight: 500,
          borderRadius: 8,
          border: `1px solid ${open ? 'var(--border-strong)' : 'var(--border)'}`,
          background: 'var(--surface)',
          color: currentModel ? 'var(--mint)' : 'rgb(var(--foreground-rgb) / 0.45)',
          cursor: 'pointer',
          transition: 'all 0.15s',
          fontFamily: 'var(--font-body)',
        }}
      >
        {displayLabel}
        <ChevronDown
          style={{
            width: 12,
            height: 12,
            opacity: 0.5,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {/* Cascading Dropdown — portaled to the body, fixed to the trigger. */}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: 'fixed',
              left: pos.left,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
              zIndex: 1000,
              display: 'flex',
              alignItems: 'flex-start',
            }}
          >
            {/* Level 1: Provider list */}
            <div
              className="border border-border bg-popover"
              style={{
                minWidth: 190,
                maxHeight: pos.maxHeight,
                overflowY: 'auto',
                borderRadius: 12,
                padding: '6px 0',
                boxShadow: 'var(--shadow-floating)',
              }}
            >
              {/* Current custom model (pinned) */}
              {isCustomModel && (
                <>
                  <button
                    type="button"
                    onClick={() => handleSelect(currentModel)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '7px 12px',
                      fontSize: 11,
                      color: 'var(--mint)',
                      background: 'rgb(var(--mint-rgb) / 0.08)',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {currentModel}
                    </span>
                    <Check style={{ width: 13, height: 13, color: 'var(--mint)', flexShrink: 0 }} />
                  </button>
                  <div
                    style={{
                      borderTop: '1px solid rgb(var(--foreground-rgb) / 0.06)',
                      margin: '2px 0',
                    }}
                  />
                </>
              )}

              {/* Search — the shared primitive (leading icon + clear + brand focus ring) */}
              <div className="px-2 pb-1.5 pt-1">
                <SearchInput
                  size="sm"
                  value={search}
                  onChange={setSearch}
                  placeholder="Search models…"
                  autoFocus
                  aria-label="Search models"
                />
              </div>

              {/* Provider rows */}
              {filteredGroups.map((group) => {
                const isActive = hoveredProvider === group.provider
                const hasSelectedModel =
                  currentModel !== null && group.models.some((m) => m.id === currentModel)
                const hasKey = isProviderConfigured(group.provider)
                return (
                  <button
                    key={group.provider}
                    type="button"
                    onMouseEnter={() => {
                      setHoveredProvider(group.provider)
                      setShowCustom(false)
                    }}
                    onClick={() => setHoveredProvider(group.provider)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '6px 12px',
                      fontSize: 12,
                      color: hasSelectedModel
                        ? 'var(--mint)'
                        : !hasKey
                          ? 'rgb(var(--foreground-rgb) / 0.5)'
                          : isActive
                            ? 'var(--foreground)'
                            : 'rgb(var(--foreground-rgb) / 0.75)',
                      background: isActive ? 'rgb(var(--foreground-rgb) / 0.06)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background 0.1s',
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        fontWeight: hasSelectedModel ? 600 : 400,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <span>{formatProviderName(group.provider)}</span>
                      {!hasKey && (
                        <span
                          style={{
                            fontSize: 9,
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 600,
                            letterSpacing: '0.1em',
                            textTransform: 'uppercase',
                            padding: '1px 5px',
                            borderRadius: 4,
                            background: 'rgb(var(--amber-rgb) / 0.12)',
                            color: 'var(--amber)',
                          }}
                        >
                          No key
                        </span>
                      )}
                    </span>
                    {hasSelectedModel && (
                      <Check
                        style={{ width: 12, height: 12, color: 'var(--mint)', flexShrink: 0 }}
                      />
                    )}
                    {!hasSelectedModel && (
                      <ChevronRight
                        style={{ width: 11, height: 11, opacity: 0.3, flexShrink: 0 }}
                      />
                    )}
                  </button>
                )
              })}

              {/* Divider + Custom */}
              <div
                style={{
                  borderTop: '1px solid rgb(var(--foreground-rgb) / 0.06)',
                  margin: '4px 0',
                }}
              />
              <button
                type="button"
                onMouseEnter={() => {
                  setHoveredProvider(null)
                  setShowCustom(true)
                }}
                onClick={() => {
                  setHoveredProvider(null)
                  setShowCustom(true)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '6px 12px',
                  fontSize: 12,
                  color: showCustom ? 'var(--foreground)' : 'rgb(var(--foreground-rgb) / 0.7)',
                  background: showCustom ? 'rgb(var(--foreground-rgb) / 0.06)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1 }}>Custom model…</span>
                <ChevronRight style={{ width: 11, height: 11, opacity: 0.4, flexShrink: 0 }} />
              </button>
            </div>

            {/* Level 2: Model list or Custom input */}
            {(activeGroup || showCustom) && (
              <div
                className="border border-border bg-popover"
                style={{
                  minWidth: 230,
                  maxHeight: pos.maxHeight,
                  overflowY: 'auto',
                  borderRadius: 12,
                  padding: '6px 0',
                  marginLeft: 4,
                  boxShadow: 'var(--shadow-floating)',
                }}
              >
                {activeGroup && (
                  <>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        color: 'rgb(var(--foreground-rgb) / 0.35)',
                        padding: '6px 14px 4px',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {formatProviderName(activeGroup.provider)}
                    </div>
                    {!activeGroupConfigured && (
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--amber)',
                          padding: '2px 14px 8px',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 600,
                          letterSpacing: '0.14em',
                          textTransform: 'uppercase',
                        }}
                      >
                        API key not configured
                      </div>
                    )}
                    {activeGroup.models.map((model) => {
                      const isSelected = currentModel === model.id
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={activeGroupConfigured ? () => handleSelect(model.id) : undefined}
                          className={[
                            'flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[12px] transition-colors',
                            isSelected
                              ? 'bg-mint/[0.08] text-mint'
                              : activeGroupConfigured
                                ? 'cursor-pointer text-foreground hover:bg-foreground/[0.06]'
                                : 'cursor-default text-foreground/45 opacity-40',
                          ].join(' ')}
                        >
                          <span className="flex-1">{model.label}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 text-mint" />}
                        </button>
                      )
                    })}
                  </>
                )}

                {showCustom && (
                  <div style={{ padding: '10px 14px' }}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.14em',
                        color: 'rgb(var(--foreground-rgb) / 0.35)',
                        marginBottom: 8,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      Custom Model
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="text"
                        value={customInput}
                        onChange={(e) => setCustomInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCustomSubmit()
                        }}
                        placeholder="provider/model-id"
                        autoFocus
                        className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15"
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!customInput.trim() || !customInput.includes('/')}
                        onClick={handleCustomSubmit}
                      >
                        Use
                      </Button>
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'rgb(var(--foreground-rgb) / 0.45)',
                        marginTop: 6,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      e.g. openrouter/minimax/minimax-m2.5
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
