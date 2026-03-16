import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useToastStore } from '@/stores/toast'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProviderConfig {
  id: string
  label: string
  envVar: string
  envFlag: 'hasAnthropicKey' | 'hasOpenAIKey' | 'hasGoogleKey'
  placeholder: string
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    envFlag: 'hasAnthropicKey',
    placeholder: 'sk-ant-...',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    envFlag: 'hasOpenAIKey',
    placeholder: 'sk-...',
  },
  {
    id: 'google',
    label: 'Google',
    envVar: 'GOOGLE_API_KEY',
    envFlag: 'hasGoogleKey',
    placeholder: 'AIza...',
  },
]

interface EnvFlags {
  hasAnthropicKey: boolean
  hasOpenAIKey: boolean
  hasGoogleKey: boolean
}

// ─── Provider Row ────────────────────────────────────────────────────────────

function ProviderRow({
  provider,
  hasKey,
  onSaved,
}: {
  provider: ProviderConfig
  hasKey: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    try {
      const res = await fetch('/api/system/openclaw-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: [{ provider: provider.id, key: apiKey.trim() }] }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      addToast({ message: `${provider.label} key updated`, type: 'success' })
      setApiKey('')
      setEditing(false)
      setShowKey(false)
      onSaved()
    } catch (err) {
      addToast({
        message: `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`,
        type: 'error',
      })
    } finally {
      setSaving(false)
    }
  }, [apiKey, provider, addToast, onSaved])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 0',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Status dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: hasKey ? '#34D399' : 'rgba(255,255,255,0.2)',
            flexShrink: 0,
          }}
        />

        {/* Provider info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#E8E8E8' }}>{provider.label}</span>
          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              color: 'rgba(232,232,232,0.3)',
              fontFamily: 'var(--font-geist-mono, monospace)',
            }}
          >
            {provider.envVar}
          </span>
        </div>

        {/* Status text + Update button */}
        <span
          style={{
            fontSize: 11,
            color: hasKey ? 'rgba(52,211,153,0.7)' : 'rgba(232,232,232,0.3)',
            marginRight: 8,
          }}
        >
          {hasKey ? 'Configured' : 'Not set'}
        </span>

        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          style={{
            height: 26,
            padding: '0 10px',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.04)',
            color: 'rgba(232,232,232,0.6)',
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {editing ? 'Cancel' : 'Update'}
        </button>
      </div>

      {/* Inline edit row */}
      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 18 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.placeholder}
              autoFocus
              style={{
                flex: 1,
                padding: '6px 10px',
                fontSize: 12,
                color: '#E8E8E8',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'var(--font-geist-mono, monospace)',
              }}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              style={{
                padding: '4px 8px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'rgba(232,232,232,0.4)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {showKey ? (
                <EyeOff style={{ width: 14, height: 14 }} />
              ) : (
                <Eye style={{ width: 14, height: 14 }} />
              )}
            </button>
          </div>

          <button
            type="button"
            disabled={!apiKey.trim() || saving}
            onClick={() => void handleSave()}
            style={{
              height: 30,
              padding: '0 14px',
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 6,
              border: 'none',
              background: !apiKey.trim() || saving ? 'rgba(52,211,153,0.2)' : '#34D399',
              color: !apiKey.trim() || saving ? 'rgba(52,211,153,0.4)' : '#0A0E1A',
              cursor: !apiKey.trim() || saving ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s',
            }}
          >
            {saving && (
              <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            )}
            Save
          </button>
        </div>
      )}
    </div>
  )
}

// ─── ApiKeyManager ───────────────────────────────────────────────────────────

export function ApiKeyManager() {
  const [envFlags, setEnvFlags] = useState<EnvFlags | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/system/openclaw-config')
      const data = (await res.json()) as { env: EnvFlags }
      setEnvFlags(data.env)
    } catch {
      // non-fatal
    }
  }, [])

  useEffect(() => {
    void fetchConfig()
  }, [fetchConfig])

  if (!envFlags) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          hasKey={envFlags[provider.envFlag]}
          onSaved={() => void fetchConfig()}
        />
      ))}
    </div>
  )
}
