import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Check, ChevronDown, ChevronLeft } from 'lucide-react'
import { findModelLabel, formatProviderName, type ModelGroup } from '@/lib/modelCatalog'
import { useModelCatalog } from '@/lib/useModelCatalog'
import { Button } from '@/features/shared/Button'
import { SearchInput } from '@/features/shared/SearchInput'

// ─── Component ───────────────────────────────────────────────────────────────

interface AgentModelSelectorProps {
  currentModel: string | null // null = "Use default"
  defaultModel: string | null // global default for display
  onModelChange: (model: string | null) => void // null = revert to default
  /** Override the model catalog. Native agents pass NATIVE_MODEL_GROUPS (native-format
   *  IDs); omitted → the OpenClaw catalog (`useModelCatalog`). */
  groups?: ModelGroup[]
  /** Override the configured-providers set (native passes its connected providers). */
  configuredProviders?: Set<string>
  /** Hide the "Default (X)" / revert-to-global-default row. Native agents always carry
   *  a concrete `primaryModel`, so there is no global-default to revert to. */
  hideDefault?: boolean
}

const LOCAL_PROVIDERS = new Set(['ollama', 'sglang', 'opencode', 'opencode-go'])

export function AgentModelSelector({
  currentModel,
  defaultModel,
  onModelChange,
  groups: groupsProp,
  configuredProviders: configuredProvidersProp,
  hideDefault = false,
}: AgentModelSelectorProps) {
  const catalog = useModelCatalog()
  const MODEL_GROUPS = groupsProp ?? catalog.groups
  const configuredProviders = configuredProvidersProp ?? catalog.configuredProviders
  const [open, setOpen] = useState(false)
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on click outside or Escape
  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      // Capture-phase + stopPropagation so Escape closes only this dropdown,
      // not the surrounding view / Settings modal.
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape, true)
    }
  }, [open])

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setSearch('')
      setCustomInput('')
      setShowCustom(false)
      setHoveredProvider(null)
    }
  }, [open])

  const handleSelectDefault = useCallback(() => {
    onModelChange(null)
    setOpen(false)
  }, [onModelChange])

  const handleSelectModel = useCallback(
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

  // Label for an id, checking the ACTIVE catalog first (native ids aren't in the
  // OpenClaw catalog `findModelLabel`), then the global OpenClaw catalog.
  const labelFor = useCallback(
    (id: string): string | null => {
      for (const g of MODEL_GROUPS) {
        const m = g.models.find((x) => x.id === id)
        if (m) return m.label
      }
      return findModelLabel(id)
    },
    [MODEL_GROUPS],
  )

  const isUsingDefault = currentModel === null
  const defaultLabel = defaultModel ? (labelFor(defaultModel) ?? defaultModel) : 'Not set'
  const displayLabel = isUsingDefault
    ? `Default (${defaultLabel})`
    : (labelFor(currentModel) ?? currentModel)

  // Determine if current model is custom (not in the active catalog and not default)
  const isCustomModel = currentModel !== null && labelFor(currentModel) === null

  // Check if a provider has API key configured
  const isProviderConfigured = useCallback(
    (provider: string) => {
      if (configuredProviders.size === 0) return true // No data yet — don't grey out
      if (LOCAL_PROVIDERS.has(provider.toLowerCase())) return true
      return configuredProviders.has(provider.toLowerCase())
    },
    [configuredProviders],
  )

  // Get active Level 2 group
  const activeGroup = hoveredProvider
    ? filteredGroups.find((g) => g.provider === hoveredProvider)
    : null
  const activeGroupConfigured = activeGroup ? isProviderConfigured(activeGroup.provider) : true

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger pill */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[200px] cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg border border-border bg-surface transition hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          height: 28,
          padding: '0 9px',
          fontSize: 11,
          fontWeight: 500,
          color: isUsingDefault ? 'rgb(var(--foreground-rgb) / 0.55)' : 'var(--mint)',
          textOverflow: 'ellipsis',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayLabel}
        </span>
        <ChevronDown
          style={{
            width: 10,
            height: 10,
            opacity: 0.4,
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {/* Cascading Dropdown — Level 2 opens LEFT */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'row-reverse',
          }}
        >
          {/* Level 1: Provider list */}
          <div
            className="border border-border bg-popover"
            style={{
              minWidth: 190,
              maxHeight: 420,
              overflowY: 'auto',
              borderRadius: 12,
              padding: '6px 0',
              boxShadow: 'var(--shadow-floating)',
            }}
          >
            {/* Default option — hidden for native agents (they carry a concrete model). */}
            {!hideDefault && (
              <button
                type="button"
                onClick={handleSelectDefault}
                onMouseEnter={() => {
                  setHoveredProvider(null)
                  setShowCustom(false)
                }}
                className={[
                  'flex w-full cursor-pointer items-center gap-1.5 border-b border-foreground/[0.06] px-3 py-[7px] text-left transition-colors',
                  isUsingDefault ? 'bg-mint/[0.08] text-mint' : 'text-foreground/50 hover:bg-foreground/[0.04]',
                ].join(' ')}
              >
                <span className="flex-1 text-[11px]">Default ({defaultLabel})</span>
                {isUsingDefault && (
                  <Check style={{ width: 12, height: 12, color: 'var(--mint)', flexShrink: 0 }} />
                )}
              </button>
            )}

            {/* Current custom model (pinned) */}
            {isCustomModel && (
              <>
                <button
                  type="button"
                  onClick={() => handleSelectModel(currentModel)}
                  onMouseEnter={() => {
                    setHoveredProvider(null)
                    setShowCustom(false)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    padding: '6px 12px',
                    fontSize: 10,
                    color: 'var(--mint)',
                    background: 'rgb(var(--mint-rgb) / 0.08)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-mono)',
                    borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
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
                  <Check style={{ width: 11, height: 11, color: 'var(--mint)', flexShrink: 0 }} />
                </button>
              </>
            )}

            {/* Search — the shared primitive (leading icon + clear + brand focus ring) */}
            <div style={{ padding: '4px 8px 6px' }}>
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
                    padding: '5px 12px',
                    fontSize: 11,
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
                  <ChevronLeft style={{ width: 10, height: 10, opacity: 0.3, flexShrink: 0 }} />
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
                    <Check style={{ width: 11, height: 11, color: 'var(--mint)', flexShrink: 0 }} />
                  )}
                </button>
              )
            })}

            {/* Divider + Custom */}
            <div
              style={{ borderTop: '1px solid rgb(var(--foreground-rgb) / 0.06)', margin: '4px 0' }}
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
                padding: '5px 12px',
                fontSize: 11,
                color: showCustom ? 'var(--foreground)' : 'rgb(var(--foreground-rgb) / 0.7)',
                background: showCustom ? 'rgb(var(--foreground-rgb) / 0.06)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <ChevronLeft style={{ width: 10, height: 10, opacity: 0.4, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Custom model…</span>
            </button>
          </div>

          {/* Level 2: Model list or Custom input — opens to the LEFT */}
          {(activeGroup || showCustom) && (
            <div
              className="border border-border bg-popover"
              style={{
                minWidth: 210,
                maxHeight: 360,
                overflowY: 'auto',
                borderRadius: 12,
                padding: '6px 0',
                marginRight: 4,
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
                        letterSpacing: '0.08em',
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
                        onClick={
                          activeGroupConfigured ? () => handleSelectModel(model.id) : undefined
                        }
                        className={[
                          'flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[12px] transition-colors',
                          isSelected
                            ? 'bg-mint/[0.08] text-mint'
                            : activeGroupConfigured
                              ? 'cursor-pointer text-foreground hover:bg-foreground/[0.04]'
                              : 'cursor-default text-foreground/45 opacity-40',
                        ].join(' ')}
                      >
                        <span style={{ flex: 1 }}>{model.label}</span>
                        {isSelected && (
                          <Check style={{ width: 13, height: 13, color: 'var(--mint)' }} />
                        )}
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
                      letterSpacing: '0.08em',
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
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
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
        </div>
      )}
    </div>
  )
}
