/**
 * features/onboarding/steps/ConfigureStep.tsx
 *
 * Model provider selection + API key entry.
 * POSTs to /api/system/configure-openclaw which writes
 * openclaw.json, .env, and auto-saves Clawboo settings.
 */

import { useCallback, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react'
import { StepIndicator } from '../StepIndicator'

// ─── Props ───────────────────────────────────────────────────────────────────

export type ConfigureStepProps = {
  onConfigured: (data: { gatewayToken: string; gatewayUrl: string }) => void
  onBack: () => void
}

// ─── Provider data ───────────────────────────────────────────────────────────

type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'moonshot'
  | 'minimax'
  | 'together'
  | 'nvidia'
  | 'huggingface'
  | 'cerebras'
  | 'venice'

interface ProviderOption {
  id: ProviderId
  name: string
  icon: string
  description: string
  placeholder: string
  needsKey: boolean
  tint: string
  tintBorder: string
  tintBg: string
}

const PRIMARY_PROVIDERS: ProviderOption[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '🅰️',
    description: 'Claude models — fast, capable, and reliable',
    placeholder: 'sk-ant-...',
    needsKey: true,
    tint: 'text-accent',
    tintBorder: 'border-accent/40',
    tintBg: 'bg-accent/8',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '🤖',
    description: 'GPT models — versatile and widely used',
    placeholder: 'sk-...',
    needsKey: true,
    tint: 'text-emerald-400',
    tintBorder: 'border-emerald-400/40',
    tintBg: 'bg-emerald-400/8',
  },
  {
    id: 'google',
    name: 'Google',
    icon: '🔷',
    description: 'Gemini models — great multimodal capabilities',
    placeholder: 'AIza...',
    needsKey: true,
    tint: 'text-blue-400',
    tintBorder: 'border-blue-400/40',
    tintBg: 'bg-blue-400/8',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '🦙',
    description: 'Run models locally — free, private, no API key',
    placeholder: '',
    needsKey: false,
    tint: 'text-amber',
    tintBorder: 'border-amber/40',
    tintBg: 'bg-amber/8',
  },
]

const MORE_PROVIDERS: ProviderOption[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '🔀',
    description: 'Access 200+ models via one API key',
    placeholder: 'sk-or-...',
    needsKey: true,
    tint: 'text-violet-400',
    tintBorder: 'border-violet-400/40',
    tintBg: 'bg-violet-400/8',
  },
  {
    id: 'xai',
    name: 'xAI',
    icon: '𝕏',
    description: 'Grok models',
    placeholder: 'xai-...',
    needsKey: true,
    tint: 'text-zinc-300',
    tintBorder: 'border-zinc-300/40',
    tintBg: 'bg-zinc-300/8',
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: '⚡',
    description: 'Ultra-fast inference',
    placeholder: 'gsk_...',
    needsKey: true,
    tint: 'text-orange-400',
    tintBorder: 'border-orange-400/40',
    tintBg: 'bg-orange-400/8',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    icon: '🌊',
    description: 'Mistral Large and more',
    placeholder: '',
    needsKey: true,
    tint: 'text-sky-400',
    tintBorder: 'border-sky-400/40',
    tintBg: 'bg-sky-400/8',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    icon: '🌙',
    description: 'Kimi models',
    placeholder: '',
    needsKey: true,
    tint: 'text-indigo-400',
    tintBorder: 'border-indigo-400/40',
    tintBg: 'bg-indigo-400/8',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    icon: '🔲',
    description: 'MiniMax M2.5 and more',
    placeholder: '',
    needsKey: true,
    tint: 'text-cyan-400',
    tintBorder: 'border-cyan-400/40',
    tintBg: 'bg-cyan-400/8',
  },
  {
    id: 'together',
    name: 'Together',
    icon: '🤝',
    description: 'Open-source models hosted',
    placeholder: '',
    needsKey: true,
    tint: 'text-teal-400',
    tintBorder: 'border-teal-400/40',
    tintBg: 'bg-teal-400/8',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    icon: '🟩',
    description: 'NVIDIA NIM endpoints',
    placeholder: 'nvapi-...',
    needsKey: true,
    tint: 'text-lime-400',
    tintBorder: 'border-lime-400/40',
    tintBg: 'bg-lime-400/8',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    icon: '🤗',
    description: 'Open models via Inference API',
    placeholder: 'hf_...',
    needsKey: true,
    tint: 'text-yellow-400',
    tintBorder: 'border-yellow-400/40',
    tintBg: 'bg-yellow-400/8',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    icon: '🧠',
    description: 'Fast wafer-scale inference',
    placeholder: '',
    needsKey: true,
    tint: 'text-rose-400',
    tintBorder: 'border-rose-400/40',
    tintBg: 'bg-rose-400/8',
  },
  {
    id: 'venice',
    name: 'Venice',
    icon: '🏛️',
    description: 'Privacy-focused AI',
    placeholder: '',
    needsKey: true,
    tint: 'text-fuchsia-400',
    tintBorder: 'border-fuchsia-400/40',
    tintBg: 'bg-fuchsia-400/8',
  },
]

const ALL_PROVIDERS: ProviderOption[] = [...PRIMARY_PROVIDERS, ...MORE_PROVIDERS]

// ─── Component ───────────────────────────────────────────────────────────────

export function ConfigureStep({ onConfigured, onBack }: ConfigureStepProps) {
  const [provider, setProvider] = useState<ProviderId | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = ALL_PROVIDERS.find((p) => p.id === provider) ?? null
  const canSubmit = provider !== null && (provider === 'ollama' || apiKey.trim().length > 0)

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
        gatewayToken: string
        gatewayUrl: string
      }
      onConfigured({ gatewayToken: data.gatewayToken, gatewayUrl: data.gatewayUrl })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [provider, apiKey, submitting, canSubmit, onConfigured])

  return (
    <div className="w-full max-w-xl rounded-2xl border border-white/8 bg-surface shadow-[0_32px_80px_rgba(0,0,0,0.65)]">
      <div className="p-8">
        <StepIndicator current="setup" />

        <h2
          className="text-[20px] font-bold text-text mb-1"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Set Up OpenClaw
        </h2>
        <p className="text-[12px] text-secondary mb-6">
          Choose your AI model provider and enter your API key.
        </p>

        {/* ── Primary provider cards ─────────────────────────── */}
        <div className="mb-4 grid grid-cols-2 gap-3">
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
                className={[
                  'flex flex-col items-start rounded-xl p-4 text-left transition',
                  isSelected
                    ? `${p.tintBorder} ${p.tintBg} ring-2 ring-white/40`
                    : 'border border-white/8 bg-background/50 hover:border-white/16 hover:bg-background/80',
                  submitting ? 'opacity-50 cursor-not-allowed' : '',
                ].join(' ')}
              >
                <span className="text-[22px] mb-1.5">{p.icon}</span>
                <span
                  className={['text-[14px] font-semibold', isSelected ? p.tint : 'text-text'].join(
                    ' ',
                  )}
                >
                  {p.name}
                </span>
                <span className="text-[11px] leading-snug text-secondary/60 mt-0.5">
                  {p.description}
                </span>
              </button>
            )
          })}
        </div>

        {/* ── More providers ──────────────────────────────────── */}
        <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary/40">
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
                className={[
                  'flex items-center gap-2 rounded-lg px-3 py-2 text-left transition',
                  isSelected
                    ? `${p.tintBorder} ${p.tintBg} ring-1 ring-white/30`
                    : 'border border-white/6 bg-background/30 hover:border-white/12 hover:bg-background/60',
                  submitting ? 'opacity-50 cursor-not-allowed' : '',
                ].join(' ')}
              >
                <span className="text-[14px] shrink-0">{p.icon}</span>
                <span
                  className={['text-[12px] font-medium', isSelected ? p.tint : 'text-text/70'].join(
                    ' ',
                  )}
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
                    className="h-10 w-full rounded-lg border border-white/10 bg-background px-3 pr-10 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-white/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
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
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
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
