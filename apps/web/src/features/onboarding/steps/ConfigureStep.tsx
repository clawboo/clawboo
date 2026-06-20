/**
 * features/onboarding/steps/ConfigureStep.tsx
 *
 * Model provider selection + API key entry.
 * POSTs to /api/system/configure-openclaw which writes
 * openclaw.json, .env, and auto-saves Clawboo settings.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Loader2 } from 'lucide-react'
import { MODEL_GROUPS } from '@/lib/modelCatalog'
import { StepIndicator } from '../StepIndicator'
import { ProviderIcon, PROVIDER_BRAND, type ProviderId } from '../ProviderIcon'
import { ModelDropdown } from '../ModelDropdown'

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
    description: 'Claude models — fast, capable, and reliable',
    placeholder: 'sk-ant-...',
    needsKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models — versatile and widely used',
    placeholder: 'sk-...',
    needsKey: true,
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini models — great multimodal capabilities',
    placeholder: 'AIza...',
    needsKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Run models locally — free, private, no API key',
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

// Selected-state styling derived from each provider's brand accent — replaces
// the old per-provider Tailwind tint classes + non-theme-aware `ring-white`.
// `currentColor` accents (Ollama / xAI) resolve to the theme foreground, giving
// a neutral selected tint for those monochrome brands.
function selectedTint(id: ProviderId): CSSProperties {
  const c = PROVIDER_BRAND[id].color
  return {
    borderColor: `color-mix(in srgb, ${c} 55%, transparent)`,
    background: `color-mix(in srgb, ${c} 12%, transparent)`,
    boxShadow: `0 0 0 1px color-mix(in srgb, ${c} 35%, transparent)`,
  }
}

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
    <div className="surface-overlay-tier w-full max-w-xl rounded-2xl">
      <div className="p-8">
        <StepIndicator current="setup" />

        <h2
          className="text-[20px] font-bold text-text mb-1"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
        >
          Set Up OpenClaw
        </h2>
        <p className="text-[12px] text-secondary mb-6">
          Choose your AI model provider and enter your API key.
        </p>

        {/* ── Primary provider cards ─────────────────────────── */}
        <div className="mb-5 grid grid-cols-2 gap-3">
          {PRIMARY_PROVIDERS.map((p) => {
            const isSelected = provider === p.id

            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setProvider(p.id)
                  setError(null)
                  if (!p.needsKey) setApiKey('')
                }}
                disabled={submitting}
                style={isSelected ? selectedTint(p.id) : undefined}
                className={[
                  'group relative flex flex-col items-start rounded-xl border p-4 text-left',
                  'transition-[border-color,background-color,box-shadow,transform] duration-200',
                  isSelected
                    ? 'border-transparent'
                    : 'border-border bg-background/40 hover:-translate-y-px hover:border-foreground/15 hover:bg-background/70',
                  submitting ? 'opacity-50 cursor-not-allowed' : '',
                ].join(' ')}
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
                <span className="mt-2.5 text-[14px] font-semibold text-text">{p.name}</span>
                <span className="mt-0.5 text-[11px] leading-snug text-secondary/70">
                  {p.description}
                </span>
              </button>
            )
          })}
        </div>

        {/* ── More providers ──────────────────────────────────── */}
        <p className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary/40">
          More providers
        </p>
        <div className="mb-5 grid grid-cols-2 gap-2">
          {MORE_PROVIDERS.map((p) => {
            const isSelected = provider === p.id

            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setProvider(p.id)
                  setError(null)
                  if (!p.needsKey) setApiKey('')
                }}
                disabled={submitting}
                style={isSelected ? selectedTint(p.id) : undefined}
                className={[
                  'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left',
                  'transition-[border-color,background-color,box-shadow] duration-150',
                  isSelected
                    ? 'border-transparent'
                    : 'border-border bg-background/25 hover:border-foreground/15 hover:bg-background/60',
                  submitting ? 'opacity-50 cursor-not-allowed' : '',
                ].join(' ')}
              >
                <ProviderIcon id={p.id} size={22} />
                <span
                  className={[
                    'text-[12px] font-medium',
                    isSelected ? 'text-text' : 'text-text/70',
                  ].join(' ')}
                >
                  {p.name}
                </span>
              </button>
            )
          })}
        </div>

        {/* ── API key input ─────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {selected && selected.needsKey && (
            <motion.div
              key="api-key"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mb-5 overflow-hidden"
            >
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary">
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={selected.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={submitting}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
                        e.preventDefault()
                        void handleSubmit()
                      }
                    }}
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 pr-10 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-foreground/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                    className="absolute inset-y-0 right-2 flex items-center text-secondary/40 transition hover:text-secondary"
                  >
                    {showApiKey ? (
                      <EyeOff className="h-4 w-4" strokeWidth={1.75} />
                    ) : (
                      <Eye className="h-4 w-4" strokeWidth={1.75} />
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Model picker ───────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {selected && availableModels && availableModels.length > 0 && (
            <motion.div
              key="model-picker"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mb-5 overflow-hidden"
            >
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary">
                  <span>Default Model</span>
                  <span className="font-mono text-[9px] font-normal text-secondary/50 normal-case tracking-wider">
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
                <p className="font-mono text-[10px] text-secondary/40">
                  You can change this anytime from System → Default Model.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Ollama hint ────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {provider === 'ollama' && (
            <motion.p
              key="ollama-hint"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mb-5 overflow-hidden font-mono text-[10px] text-amber/60"
            >
              Make sure Ollama is running locally on port 11434.
            </motion.p>
          )}
        </AnimatePresence>

        {/* ── Error ──────────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {error && (
            <motion.div
              key="error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mb-4 overflow-hidden"
            >
              <div
                role="alert"
                className="rounded-lg border border-destructive/20 bg-destructive/8 px-3 py-2 text-[12px] leading-snug text-destructive"
              >
                {error}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Submit button ──────────────────────────────────── */}
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit || submitting}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-primary-foreground shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
              Configuring…
            </>
          ) : (
            <>
              Configure & Start
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
            </>
          )}
        </button>

        {/* ── Back link ──────────────────────────────────────── */}
        <p className="mt-5 text-center">
          <button
            type="button"
            onClick={onBack}
            disabled={submitting}
            className="flex items-center justify-center gap-1 mx-auto font-mono text-[11px] text-secondary/35 underline underline-offset-2 transition hover:text-secondary disabled:opacity-50"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </button>
        </p>
      </div>
    </div>
  )
}
