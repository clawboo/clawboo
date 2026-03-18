import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Check, ChevronDown, ChevronLeft } from 'lucide-react'
import { findModelLabel } from '@/lib/modelCatalog'
import { useModelCatalog } from '@/lib/useModelCatalog'

// ─── Component ───────────────────────────────────────────────────────────────

interface AgentModelSelectorProps {
  currentModel: string | null // null = "Use default"
  defaultModel: string | null // global default for display
  onModelChange: (model: string | null) => void // null = revert to default
}

const LOCAL_PROVIDERS = new Set(['ollama', 'sglang', 'opencode', 'opencode-go'])

export function AgentModelSelector({
  currentModel,
  defaultModel,
  onModelChange,
}: AgentModelSelectorProps) {
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

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setSearch('')
      setCustomInput('')
      setShowCustom(false)
      setHoveredProvider(null)
      setTimeout(() => searchRef.current?.focus(), 0)
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

  const isUsingDefault = currentModel === null
  const defaultLabel = defaultModel ? (findModelLabel(defaultModel) ?? defaultModel) : 'Not set'
  const displayLabel = isUsingDefault
    ? `Default (${defaultLabel})`
    : (findModelLabel(currentModel) ?? currentModel)

  // Determine if current model is custom (not in catalog and not default)
  const isCustomModel = currentModel !== null && findModelLabel(currentModel) === null

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
          gap: 4,
          height: 26,
          padding: '0 8px',
          fontSize: 11,
          fontWeight: 500,
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.03)',
          color: isUsingDefault ? 'rgba(232,232,232,0.45)' : '#34D399',
          cursor: 'pointer',
          transition: 'all 0.15s',
          fontFamily: 'var(--font-body)',
          maxWidth: 200,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
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
            style={{
              minWidth: 175,
              maxHeight: 420,
              overflowY: 'auto',
              background: '#111827',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10,
              padding: '6px 0',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
          >
            {/* Default option */}
            <button
              type="button"
              onClick={handleSelectDefault}
              onMouseEnter={() => {
                setHoveredProvider(null)
                setShowCustom(false)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '7px 12px',
                fontSize: 12,
                color: isUsingDefault ? '#34D399' : 'rgba(232,232,232,0.5)',
                background: isUsingDefault ? 'rgba(52,211,153,0.08)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
              onMouseOver={(e) => {
                if (!isUsingDefault) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
              }}
              onMouseOut={(e) => {
                if (!isUsingDefault) e.currentTarget.style.background = 'transparent'
              }}
            >
              <span style={{ flex: 1, fontSize: 11 }}>Default ({defaultLabel})</span>
              {isUsingDefault && (
                <Check style={{ width: 12, height: 12, color: '#34D399', flexShrink: 0 }} />
              )}
            </button>

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
                    color: '#34D399',
                    background: 'rgba(52,211,153,0.08)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-geist-mono, monospace)',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
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
                  <Check style={{ width: 11, height: 11, color: '#34D399', flexShrink: 0 }} />
                </button>
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
                  padding: '4px 8px',
                  fontSize: 11,
                  color: '#E8E8E8',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
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
                    padding: '5px 12px',
                    fontSize: 11,
                    color: hasSelectedModel
                      ? '#34D399'
                      : !hasKey
                        ? 'rgba(232,232,232,0.25)'
                        : isActive
                          ? '#E8E8E8'
                          : 'rgba(232,232,232,0.7)',
                    background: isActive ? 'rgba(255,255,255,0.06)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s',
                  }}
                >
                  <ChevronLeft style={{ width: 10, height: 10, opacity: 0.3, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontWeight: hasSelectedModel ? 600 : 400 }}>
                    {group.provider}
                    {!hasKey && (
                      <span
                        style={{ fontSize: 9, fontStyle: 'italic', marginLeft: 6, opacity: 0.6 }}
                      >
                        No API key
                      </span>
                    )}
                  </span>
                  {hasSelectedModel && (
                    <Check style={{ width: 11, height: 11, color: '#34D399', flexShrink: 0 }} />
                  )}
                </button>
              )
            })}

            {/* Divider + Custom */}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '4px 0' }} />
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
                color: showCustom ? '#E8E8E8' : 'rgba(232,232,232,0.5)',
                background: showCustom ? 'rgba(255,255,255,0.06)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontStyle: 'italic',
              }}
            >
              <ChevronLeft style={{ width: 10, height: 10, opacity: 0.3, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Custom model...</span>
            </button>
          </div>

          {/* Level 2: Model list or Custom input — opens to the LEFT */}
          {(activeGroup || showCustom) && (
            <div
              style={{
                minWidth: 210,
                maxHeight: 360,
                overflowY: 'auto',
                background: '#111827',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: '6px 0',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                marginRight: 4,
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
                      color: 'rgba(232,232,232,0.35)',
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
                        color: 'rgba(251,191,36,0.5)',
                        padding: '2px 14px 6px',
                        fontStyle: 'italic',
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
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          width: '100%',
                          padding: '6px 14px',
                          fontSize: 12,
                          color: !activeGroupConfigured
                            ? 'rgba(232,232,232,0.25)'
                            : isSelected
                              ? '#34D399'
                              : '#E8E8E8',
                          background: isSelected ? 'rgba(52,211,153,0.08)' : 'transparent',
                          border: 'none',
                          cursor: activeGroupConfigured ? 'pointer' : 'default',
                          textAlign: 'left',
                          transition: 'background 0.1s',
                          opacity: activeGroupConfigured ? 1 : 0.4,
                        }}
                        onMouseEnter={(e) => {
                          if (activeGroupConfigured && !isSelected)
                            e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                        }}
                        onMouseLeave={(e) => {
                          if (activeGroupConfigured && !isSelected)
                            e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <span style={{ flex: 1 }}>{model.label}</span>
                        {isSelected && (
                          <Check style={{ width: 13, height: 13, color: '#34D399' }} />
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
                      color: 'rgba(232,232,232,0.35)',
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
                        padding: '5px 8px',
                        fontSize: 11,
                        color: '#E8E8E8',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.1)',
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
                            ? 'rgba(52,211,153,0.15)'
                            : '#34D399',
                        color:
                          !customInput.trim() || !customInput.includes('/')
                            ? 'rgba(52,211,153,0.4)'
                            : '#0A0E1A',
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
                      color: 'rgba(232,232,232,0.25)',
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
