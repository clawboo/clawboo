import { useState, useEffect, useRef, useCallback } from 'react'
import { Check, ChevronDown } from 'lucide-react'

// ─── Model catalog ───────────────────────────────────────────────────────────

interface ModelOption {
  id: string
  label: string
}

interface ModelGroup {
  provider: string
  models: ModelOption[]
}

const MODEL_GROUPS: ModelGroup[] = [
  {
    provider: 'Anthropic',
    models: [
      { id: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
      { id: 'anthropic/claude-opus-4-20250514', label: 'Claude Opus 4' },
      { id: 'anthropic/claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5' },
    ],
  },
  {
    provider: 'OpenAI',
    models: [
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'openai/o3-mini', label: 'o3-mini' },
    ],
  },
  {
    provider: 'Google',
    models: [
      { id: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
  {
    provider: 'Ollama (Local)',
    models: [
      { id: 'ollama/llama3.2', label: 'Llama 3.2' },
      { id: 'ollama/mistral', label: 'Mistral' },
      { id: 'ollama/codellama', label: 'Code Llama' },
    ],
  },
]

function findModelLabel(id: string): string | null {
  for (const group of MODEL_GROUPS) {
    const match = group.models.find((m) => m.id === id)
    if (match) return match.label
  }
  return null
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ModelSelectorProps {
  currentModel: string | null
  onModelChange: (model: string) => void
}

export function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
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
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const handleSelect = useCallback(
    (modelId: string) => {
      onModelChange(modelId)
      setOpen(false)
    },
    [onModelChange],
  )

  const displayLabel = currentModel ? (findModelLabel(currentModel) ?? currentModel) : 'Not set'

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
          border: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.04)',
          color: currentModel ? '#34D399' : 'rgba(232,232,232,0.45)',
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

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 50,
            minWidth: 240,
            maxHeight: 300,
            overflowY: 'auto',
            background: '#111827',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10,
            padding: '6px 0',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          {MODEL_GROUPS.map((group) => (
            <div key={group.provider}>
              {/* Provider header */}
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'rgba(232,232,232,0.35)',
                  padding: '8px 14px 4px',
                  fontFamily: 'var(--font-geist-mono, monospace)',
                }}
              >
                {group.provider}
              </div>

              {/* Model rows */}
              {group.models.map((model) => {
                const isSelected = currentModel === model.id
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => handleSelect(model.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 14px',
                      fontSize: 12,
                      color: isSelected ? '#34D399' : '#E8E8E8',
                      background: isSelected ? 'rgba(52,211,153,0.08)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <span style={{ flex: 1 }}>{model.label}</span>
                    {isSelected && <Check style={{ width: 14, height: 14, color: '#34D399' }} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
