/**
 * features/onboarding/steps/ConfigureStep.tsx
 *
 * Model provider selection + API key entry.
 * POSTs to /api/system/configure-openclaw which writes
 * openclaw.json, .env, and auto-saves Clawboo settings.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Loader2 } from 'lucide-react'
import { MODEL_GROUPS } from '@/lib/modelCatalog'
import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'
import { ProviderIcon, PROVIDER_BRAND, type ProviderId } from '../ProviderIcon'
import { ModelDropdown } from '../ModelDropdown'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

// ─── Props ───────────────────────────────────────────────────────────────────

export type ConfigureStepProps = {
  onConfigured: (data: { gatewayUrl: string }) => void
  onBack: () => void
}

// ─── Provider data ───────────────────────────────────────────────────────────
//
// Brand marks + accent colors live in `../ProviderIcon` (authentic logos via
// simple-icons + lettermark fallbacks). Here we only carry the copy + key
// requirements; the selected-state tint is derived from each provider's accent.

interface ProviderOption {
  id: ProviderId
  name: string
  description: string
  placeholder: string
  needsKey: boolean
}

const PRIMARY_PROVIDERS: ProviderOption[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models: fast, capable, and reliable',
    placeholder: 'sk-ant-...',
    needsKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models: versatile and widely used',
    placeholder: 'sk-...',
    needsKey: true,
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini models: great multimodal capabilities',
    placeholder: 'AIza...',
    needsKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run models locally: free, private, no API key',
    placeholder: '',
    needsKey: false,
  },
]

const MORE_PROVIDERS: ProviderOption[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 200+ models via one API key',
    placeholder: 'sk-or-...',
    needsKey: true,
  },
  { id: 'xai', name: 'xAI', description: 'Grok models', placeholder: 'xai-...', needsKey: true },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Ultra-fast inference',
    placeholder: 'gsk_...',
    needsKey: true,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Mistral Large and more',
    placeholder: '',
    needsKey: true,
  },
  { id: 'moonshot', name: 'Moonshot', description: 'Kimi models', placeholder: '', needsKey: true },
  {
    id: 'minimax',
    name: 'MiniMax',
    description: 'MiniMax M2.5 and more',
    placeholder: '',
    needsKey: true,
  },
  {
    id: 'together',
    name: 'Together',
    description: 'Open-source models hosted',
    placeholder: '',
    needsKey: true,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    description: 'NVIDIA NIM endpoints',
    placeholder: 'nvapi-...',
    needsKey: true,
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Open models via Inference API',
    placeholder: 'hf_...',
    needsKey: true,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Fast wafer-scale inference',
    placeholder: '',
    needsKey: true,
  },
  {
    id: 'venice',
    name: 'Venice',
    description: 'Privacy-focused AI',
    placeholder: '',
    needsKey: true,
  },
]

const ALL_PROVIDERS: ProviderOption[] = [...PRIMARY_PROVIDERS, ...MORE_PROVIDERS]

// ─── Provider → model-catalog mapping ────────────────────────────────────────
//
// `ProviderId` values are lowercase tokens used in the API. `MODEL_GROUPS`
// in `lib/modelCatalog.ts` uses display-case provider names. This bridges
// the two so the picker can find the right model list for the selected
// provider card.

const PROVIDER_TO_CATALOG_NAME: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  ollama: 'Ollama (Local)',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  moonshot: 'Moonshot',
  minimax: 'MiniMax',
  together: 'Together',
  nvidia: 'NVIDIA',
  huggingface: 'Hugging Face',
  cerebras: 'Cerebras',
  venice: 'Venice',
}

/** Returns the models available for a provider, or null if no catalog entry exists. */
function getModelsForProvider(provider: ProviderId): { id: string; label: string }[] | null {
  const catalogName = PROVIDER_TO_CATALOG_NAME[provider]
  const group = MODEL_GROUPS.find((g) => g.provider === catalogName)
  return group?.models ?? null
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ConfigureStep({ onConfigured, onBack }: ConfigureStepProps) {
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [model, setModel] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = ALL_PROVIDERS.find((p) => p.id === provider) ?? null
  const availableModels = useMemo(
    () => (provider ? getModelsForProvider(provider) : null),
    [provider],
  )
  const canSubmit = provider !== null && (provider === 'ollama' || apiKey.trim().length > 0)

  // Default to the first (recommended) model in the catalog whenever the
  // provider changes. The catalog is ordered with the most capable / most
  // common model first, which makes the right choice for an onboarding
  // user — they can still pick a smaller / faster variant from the
  // dropdown before submitting.
  useEffect(() => {
    if (!provider) {
      setModel('')
      return
    }
    const models = getModelsForProvider(provider)
    if (models && models.length > 0) {
      setModel(models[0]!.id)
    } else {
      setModel('')
    }
  }, [provider])

  const handleSubmit = useCallback(async () => {
    if (!provider || submitting || !canSubmit) return

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/system/configure-openclaw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey: provider === 'ollama' ? undefined : apiKey.trim(),
          // Send the user-chosen default model. The server falls back to its
          // own MODEL_MAP if `model` is empty / unrecognised — so this is
          // an additive change, never a breaking one.
          model: model.trim() || undefined,
        }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error ?? `Server returned ${res.status}`)
      }

      const data = (await res.json()) as {
        ok: boolean
        gatewayUrl: string
      }
      // The provisioning token is persisted server-side and injected by the proxy on
      // connect — the browser only needs the URL.
      onConfigured({ gatewayUrl: data.gatewayUrl })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [provider, apiKey, model, submitting, canSubmit, onConfigured])

  return (
    <OnboardingScreen
      testId="configure-openclaw-step"
      step="runtimes"
      steps={NATIVE_STEPS}
      size="lg"
      title="Configure OpenClaw"
      subtitle="Choose your AI model provider and paste an API key. Clawboo will write your OpenClaw config and start the gateway."
      footer={
        <div className="flex items-center justify-between">
          <OnboardingGhost onClick={onBack} disabled={submitting}>
            <ArrowLeft size={15} /> Back
          </OnboardingGhost>
          <OnboardingPrimary
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || submitting}
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
            {submitting ? 'Configuring…' : 'Configure & Start'}
            {!submitting && <ArrowRight size={16} />}
          </OnboardingPrimary>
        </div>
      }
    >
      {/* Primary provider cards */}
      <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Provider">
        {PRIMARY_PROVIDERS.map((p) => {
          const isSelected = provider === p.id

          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                setProvider(p.id)
                setError(null)
                if (!p.needsKey) setApiKey('')
              }}
              disabled={submitting}
              className={[
                'group relative flex flex-col items-start rounded-2xl border p-4 text-left',
                'transition-[transform,border-color,box-shadow,background-color] duration-150',
                isSelected
                  ? ''
                  : 'border-border bg-surface hover:-translate-y-px hover:border-foreground/20',
                submitting ? 'opacity-50' : '',
              ].join(' ')}
              style={{
                cursor: submitting ? 'not-allowed' : 'pointer',
                ...(isSelected
                  ? {
                      borderColor: 'var(--primary)',
                      background: 'rgb(var(--primary-rgb) / 0.05)',
                      boxShadow: '0 0 0 1px var(--primary)',
                    }
                  : { boxShadow: 'var(--shadow-raised)' }),
              }}
            >
              {isSelected && (
                <span
                  className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ background: PROVIDER_BRAND[p.id].color, color: 'var(--background)' }}
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
              )}
              <ProviderIcon id={p.id} size={36} />
              <span
                className="mt-2.5 text-[14px] font-semibold"
                style={{ color: 'var(--foreground)' }}
              >
                {p.name}
              </span>
              <span className="mt-0.5 text-[12px] leading-snug" style={{ color: muted(0.5) }}>
                {p.description}
              </span>
            </button>
          )
        })}
      </div>

      {/* More providers */}
      <p
        className="mb-2.5 mt-6 font-mono text-[11px] uppercase tracking-[0.14em]"
        style={{ color: muted(0.5) }}
      >
        More providers
      </p>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="More providers">
        {MORE_PROVIDERS.map((p) => {
          const isSelected = provider === p.id

          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => {
                setProvider(p.id)
                setError(null)
                if (!p.needsKey) setApiKey('')
              }}
              disabled={submitting}
              className={[
                'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left',
                'transition-[transform,border-color,box-shadow,background-color] duration-150',
                isSelected
                  ? ''
                  : 'border-border bg-surface hover:-translate-y-px hover:border-foreground/20',
                submitting ? 'opacity-50' : '',
              ].join(' ')}
              style={{
                cursor: submitting ? 'not-allowed' : 'pointer',
                ...(isSelected
                  ? {
                      borderColor: 'var(--primary)',
                      background: 'rgb(var(--primary-rgb) / 0.05)',
                      boxShadow: '0 0 0 1px var(--primary)',
                    }
                  : { boxShadow: 'var(--shadow-raised)' }),
              }}
            >
              <ProviderIcon id={p.id} size={22} />
              <span
                className="text-[13px] font-medium"
                style={{ color: isSelected ? 'var(--foreground)' : muted(0.7) }}
              >
                {p.name}
              </span>
            </button>
          )
        })}
      </div>

      {/* API key input */}
      <AnimatePresence initial={false}>
        {selected && selected.needsKey && (
          <motion.div
            key="api-key"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-6 overflow-hidden"
          >
            <div className="flex flex-col gap-2">
              <label
                htmlFor="openclaw-api-key-input"
                className="font-mono text-[11px] uppercase tracking-[0.14em]"
                style={{ color: muted(0.5) }}
              >
                API Key
              </label>
              <div className="relative">
                <input
                  id="openclaw-api-key-input"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={selected.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={submitting}
                  aria-label="OpenClaw provider API key"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
                      e.preventDefault()
                      void handleSubmit()
                    }
                  }}
                  className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 pr-11 font-mono text-[14px] text-foreground outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50 placeholder:text-foreground/30"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground/40 transition-colors hover:text-foreground/70"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Model picker */}
      <AnimatePresence initial={false}>
        {selected && availableModels && availableModels.length > 0 && (
          <motion.div
            key="model-picker"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-5 overflow-hidden"
          >
            <div className="flex flex-col gap-2">
              <label
                className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em]"
                style={{ color: muted(0.5) }}
              >
                <span>Default Model</span>
                <span className="font-mono text-[10px] normal-case tracking-wider" style={{ color: muted(0.4) }}>
                  used for new agents
                </span>
              </label>
              <ModelDropdown
                aria-label="Default model"
                value={model}
                onChange={setModel}
                disabled={submitting}
                options={availableModels.map((m) => ({ id: m.id, label: m.label }))}
              />
              <p className="font-mono text-[10px]" style={{ color: muted(0.4) }}>
                You can change this anytime from System → Default Model.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Ollama hint */}
      <AnimatePresence initial={false}>
        {provider === 'ollama' && (
          <motion.p
            key="ollama-hint"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-5 overflow-hidden text-[13px] leading-relaxed"
            style={{ color: muted(0.55) }}
          >
            No key needed. Make sure Ollama is running locally on port 11434.
          </motion.p>
        )}
      </AnimatePresence>

      {/* Error */}
      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            key="error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-5 overflow-hidden"
          >
            <div
              role="alert"
              className="rounded-xl border border-destructive/20 bg-destructive/8 px-3 py-2 text-[13px] leading-snug text-destructive"
            >
              {error}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </OnboardingScreen>
  )
}
