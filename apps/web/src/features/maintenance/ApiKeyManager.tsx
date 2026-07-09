import { useState, useEffect, useCallback } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useToastStore } from '@/stores/toast'
import { Button } from '@/features/shared/Button'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProviderConfig {
  id: string
  label: string
  envVar: string
  envFlag: string
  placeholder: string
}

const PRIMARY_PROVIDERS: ProviderConfig[] = [
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
    envVar: 'GEMINI_API_KEY',
    envFlag: 'hasGoogleKey',
    placeholder: 'AIza...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    envFlag: 'hasOpenRouterKey',
    placeholder: 'sk-or-...',
  },
  {
    id: 'xai',
    label: 'xAI',
    envVar: 'XAI_API_KEY',
    envFlag: 'hasXaiKey',
    placeholder: 'xai-...',
  },
  {
    id: 'groq',
    label: 'Groq',
    envVar: 'GROQ_API_KEY',
    envFlag: 'hasGroqKey',
    placeholder: 'gsk_...',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    envVar: 'MISTRAL_API_KEY',
    envFlag: 'hasMistralKey',
    placeholder: 'M...',
  },
]

const ADDITIONAL_PROVIDERS: ProviderConfig[] = [
  {
    id: 'moonshot',
    label: 'Moonshot',
    envVar: 'MOONSHOT_API_KEY',
    envFlag: 'hasMoonshotKey',
    placeholder: 'sk-...',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    envVar: 'MINIMAX_API_KEY',
    envFlag: 'hasMiniMaxKey',
    placeholder: 'eyJh...',
  },
  {
    id: 'together',
    label: 'Together',
    envVar: 'TOGETHER_API_KEY',
    envFlag: 'hasTogetherKey',
    placeholder: '',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    envVar: 'NVIDIA_API_KEY',
    envFlag: 'hasNvidiaKey',
    placeholder: 'nvapi-...',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    envVar: 'HF_TOKEN',
    envFlag: 'hasHuggingFaceKey',
    placeholder: 'hf_...',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    envVar: 'CEREBRAS_API_KEY',
    envFlag: 'hasCerebrasKey',
    placeholder: 'csk-...',
  },
  {
    id: 'venice',
    label: 'Venice',
    envVar: 'VENICE_API_KEY',
    envFlag: 'hasVeniceKey',
    placeholder: 'vapi_...',
  },
]

type EnvFlags = Record<string, boolean>

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
    <div className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        {/* Status dot */}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${hasKey ? 'bg-mint' : 'bg-foreground/20'}`}
        />

        {/* Provider info */}
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium text-foreground">{provider.label}</span>
          <span className="font-data ml-2 text-[11px] text-foreground/35">{provider.envVar}</span>
        </div>

        {/* Status text + Update button */}
        <span
          className={`mr-1 text-[11px] font-medium ${hasKey ? 'text-mint' : 'text-foreground/35'}`}
        >
          {hasKey ? 'Configured' : 'Not set'}
        </span>

        <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel' : 'Update'}
        </Button>
      </div>

      {/* Inline edit row */}
      {editing && (
        <div className="flex items-center gap-2 pl-5">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.placeholder}
              autoFocus
              className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 pr-11 font-mono text-[13px] text-foreground outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15 placeholder:text-foreground/30"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-md border-none bg-transparent p-1 text-foreground/40 transition-colors hover:text-foreground/70"
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <Button
            variant="primary"
            size="sm"
            disabled={!apiKey.trim()}
            loading={saving}
            onClick={() => void handleSave()}
          >
            Save
          </Button>
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
    <div className="flex flex-col">
      {PRIMARY_PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          hasKey={envFlags[provider.envFlag]}
          onSaved={() => void fetchConfig()}
        />
      ))}

      {/* Divider */}
      <div className="flex items-center gap-3 pb-1.5 pt-4">
        <div className="flex-1 border-t border-border" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
          Additional Providers
        </span>
        <div className="flex-1 border-t border-border" />
      </div>

      {ADDITIONAL_PROVIDERS.map((provider) => (
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
