import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { findModelLabel } from '@/lib/modelCatalog'
import { useModelCatalog } from '@/lib/useModelCatalog'

// ─── Component ───────────────────────────────────────────────────────────────

interface ModelSelectorProps {
  currentModel: string | null
  onModelChange: (model: string) => void
}

const LOCAL_PROVIDERS = new Set(['ollama', 'sglang', 'opencode', 'opencode-go'])

export function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const { groups: MODEL_GROUPS, configuredProviders } = useModelCatalog()
  const [open, setOpen] = useState(false)
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Close on click outside or Escape
  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  // Focus search when opening
  useEffect(() => {
    if (open) {
      setSearch('')
      setCustomInput('')
      setShowCustom(false)
      setHoveredProvider(null)
      setTimeout(() => searchRef.current?.focus(), 0)
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
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 12px',
          fontSize: 12,
          fontWeight: 500,
          borderRadius: 8,
          border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
          background: 'rgb(var(--foreground-rgb) / 0.04)',
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

      {/* Cascading Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 50,
            display: 'flex',
          }}
        >
          {/* Level 1: Provider list */}
          <div
            className="surface-floating-tier"
            style={{
              minWidth: 190,
              maxHeight: 420,
              overflowY: 'auto',
              borderRadius: 10,
              padding: '6px 0',
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
                    fontFamily: 'var(--font-geist-mono, monospace)',
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

            {/* Search */}
            <div style={{ padding: '4px 8px 6px' }}>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                style={{
                  width: '100%',
                  padding: '5px 8px',
                  fontSize: 11,
                  color: 'var(--foreground)',
                  background: 'rgb(var(--foreground-rgb) / 0.04)',
                  border: '1px solid rgb(var(--foreground-rgb) / 0.08)',
                  borderRadius: 6,
                  outline: 'none',
                  fontFamily: 'var(--font-geist-mono, monospace)',
                }}
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
                    <span>{group.provider}</span>
                    {!hasKey && (
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'var(--font-geist-mono, monospace)',
                          fontWeight: 600,
                          letterSpacing: '0.08em',
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
                    <Check style={{ width: 12, height: 12, color: 'var(--mint)', flexShrink: 0 }} />
                  )}
                  {!hasSelectedModel && (
                    <ChevronRight style={{ width: 11, height: 11, opacity: 0.3, flexShrink: 0 }} />
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
              className="surface-floating-tier"
              style={{
                minWidth: 230,
                maxHeight: 380,
                overflowY: 'auto',
                borderRadius: 10,
                padding: '6px 0',
                marginLeft: 4,
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
                      fontFamily: 'var(--font-geist-mono, monospace)',
                    }}
                  >
                    {activeGroup.provider}
                  </div>
                  {!activeGroupConfigured && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--amber)',
                        padding: '2px 14px 8px',
                        fontFamily: 'var(--font-geist-mono, monospace)',
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
                        onClick={activeGroupConfigured ? () => handleSelect(model.id) : undefined}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          padding: '6px 14px',
                          fontSize: 12,
                          color: !activeGroupConfigured
                            ? 'rgb(var(--foreground-rgb) / 0.45)'
                            : isSelected
                              ? 'var(--mint)'
                              : 'var(--foreground)',
                          background: isSelected ? 'rgb(var(--mint-rgb) / 0.08)' : 'transparent',
                          border: 'none',
                          cursor: activeGroupConfigured ? 'pointer' : 'default',
                          textAlign: 'left',
                          transition: 'background 0.1s',
                          opacity: activeGroupConfigured ? 1 : 0.4,
                        }}
                        onMouseEnter={(e) => {
                          if (activeGroupConfigured && !isSelected)
                            e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.04)'
                        }}
                        onMouseLeave={(e) => {
                          if (activeGroupConfigured && !isSelected)
                            e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <span style={{ flex: 1 }}>{model.label}</span>
                        {isSelected && (
                          <Check style={{ width: 14, height: 14, color: 'var(--mint)' }} />
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
                      fontFamily: 'var(--font-geist-mono, monospace)',
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
                      style={{
                        flex: 1,
                        padding: '6px 8px',
                        fontSize: 11,
                        color: 'var(--foreground)',
                        background: 'rgb(var(--foreground-rgb) / 0.04)',
                        border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
                        borderRadius: 6,
                        outline: 'none',
                        fontFamily: 'var(--font-geist-mono, monospace)',
                      }}
                    />
                    <button
                      type="button"
                      disabled={!customInput.trim() || !customInput.includes('/')}
                      onClick={handleCustomSubmit}
                      style={{
                        padding: '0 10px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: 'none',
                        background:
                          !customInput.trim() || !customInput.includes('/')
                            ? 'rgb(var(--mint-rgb) / 0.15)'
                            : 'var(--mint)',
                        color:
                          !customInput.trim() || !customInput.includes('/')
                            ? 'rgb(var(--mint-rgb) / 0.4)'
                            : 'var(--background)',
                        cursor:
                          !customInput.trim() || !customInput.includes('/') ? 'default' : 'pointer',
                      }}
                    >
                      Use
                    </button>
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'rgb(var(--foreground-rgb) / 0.45)',
                      marginTop: 6,
                      fontFamily: 'var(--font-geist-mono, monospace)',
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
