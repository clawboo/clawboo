// Native runtime setup: pick a provider, paste a key (or use a local Ollama
// model), optionally test it, then seed a starter leader + specialist team.
// Mirrors ConfigureStep's key-input affordance (Eye/EyeOff reveal). The key is
// written to the encrypted vault via the runtime connect route — never directly.

import { useCallback, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Loader2, X } from 'lucide-react'

import { NATIVE_STEPS, StepIndicator } from '../StepIndicator'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { connectRuntime, healthcheckNativeKey } from '@/lib/runtimesClient'
import { seedNativeTeam } from '@/lib/onboardingClient'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

type Provider = 'anthropic' | 'openai' | 'openrouter' | 'ollama'

const PROVIDERS: { id: Exclude<Provider, 'ollama'>; name: string; placeholder: string }[] = [
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…' },
]

type TestState = { phase: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }

export interface ConfigureNativeStepProps {
  /** Fired with the seeded team id once the key is connected + team is minted. */
  onSeeded: (teamId: string | null) => void
  /** Back to the runtime-choice step. */
  onBack: () => void
}

export function ConfigureNativeStep({ onSeeded, onBack }: ConfigureNativeStepProps) {
  const [provider, setProvider] = useState<Exclude<Provider, 'ollama'>>('anthropic')
  const [useOllama, setUseOllama] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveProvider: Provider = useOllama ? 'ollama' : provider
  const placeholder = PROVIDERS.find((p) => p.id === provider)?.placeholder ?? 'sk-…'
  const canSubmit = useOllama || apiKey.trim().length > 0

  const resetTest = useCallback(() => setTest({ phase: 'idle' }), [])

  const handleTest = useCallback(async () => {
    setTest({ phase: 'testing' })
    setError(null)
    const r = await healthcheckNativeKey(effectiveProvider, apiKey.trim())
    setTest(
      r.ok ? { phase: 'ok' } : { phase: 'fail', message: r.error ?? 'Could not verify the key.' },
    )
  }, [effectiveProvider, apiKey])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    // 1. Store the key in the encrypted vault (the multi-provider native slot).
    const c = await connectRuntime('clawboo-native', apiKey.trim(), effectiveProvider)
    if (!c.ok) {
      setSubmitting(false)
      setError(c.error ?? 'Failed to save the key')
      return
    }
    // 2. Seed a starter leader + specialist team.
    const seed = await seedNativeTeam(effectiveProvider)
    setSubmitting(false)
    if (!seed.ok) {
      setError(seed.error ?? 'Could not create the starter team')
      return
    }
    onSeeded(seed.teamId ?? null)
  }, [canSubmit, submitting, apiKey, effectiveProvider, onSeeded])

  return (
    <div
      data-testid="configure-native-step"
      className="surface-overlay-tier w-full max-w-[440px] rounded-2xl p-8"
    >
      <div className="flex flex-col items-center">
        <StepIndicator current="connect" steps={NATIVE_STEPS} />
        <h2
          className="mt-6 font-display text-[22px] font-semibold"
          style={{ color: 'var(--foreground)', letterSpacing: '-0.01em' }}
        >
          Connect Clawboo Native
        </h2>
        <p
          className="mt-1.5 text-center text-[12px] leading-relaxed"
          style={{ color: muted(0.55), maxWidth: 360 }}
        >
          Paste a provider key — we&apos;ll set up a starter team for you in seconds.
        </p>
      </div>

      {/* Provider pills */}
      <div className="mt-6 flex gap-2" aria-label="Provider">
        {PROVIDERS.map((p) => {
          const active = !useOllama && provider === p.id
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`native-provider-${p.id}`}
              disabled={useOllama}
              aria-pressed={active}
              onClick={() => {
                setProvider(p.id)
                resetTest()
              }}
              className="flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition disabled:opacity-40"
              style={{
                background: active ? 'rgb(var(--primary-rgb) / 0.12)' : muted(0.04),
                color: active ? 'var(--primary)' : muted(0.6),
                border: `1px solid ${active ? 'rgb(var(--primary-rgb) / 0.4)' : muted(0.1)}`,
                cursor: useOllama ? 'not-allowed' : 'pointer',
              }}
            >
              {p.name}
            </button>
          )
        })}
      </div>

      {/* API key (hidden when using Ollama) */}
      {!useOllama && (
        <div className="mt-4 flex flex-col gap-1.5">
          <label
            className="font-mono text-[10px] uppercase tracking-widest"
            style={{ color: muted(0.5) }}
          >
            API Key
          </label>
          <div className="relative">
            <input
              data-testid="native-api-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                resetTest()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) void handleSubmit()
              }}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              disabled={submitting}
              aria-label="Native provider API key"
              className="w-full rounded-lg px-3 py-2.5 pr-10 font-mono text-[13px] outline-none disabled:opacity-50"
              style={{
                background: 'var(--background)',
                border: `1px solid ${muted(0.12)}`,
                color: 'var(--foreground)',
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              style={{
                color: muted(0.45),
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      )}

      {/* Ollama expander */}
      <button
        type="button"
        data-testid="native-ollama-toggle"
        aria-pressed={useOllama}
        onClick={() => {
          setUseOllama((v) => !v)
          resetTest()
          setError(null)
        }}
        className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] transition"
        style={{
          background: useOllama ? 'rgb(var(--mint-rgb) / 0.1)' : muted(0.03),
          border: `1px solid ${useOllama ? 'rgb(var(--mint-rgb) / 0.35)' : muted(0.08)}`,
          color: useOllama ? 'var(--mint)' : muted(0.55),
          cursor: 'pointer',
        }}
      >
        <span
          className="flex h-4 w-4 items-center justify-center rounded"
          style={{ border: `1.5px solid ${useOllama ? 'var(--mint)' : muted(0.3)}` }}
        >
          {useOllama && <Check size={11} />}
        </span>
        Use a local model with Ollama — no key needed
      </button>

      {/* Test connection */}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          data-testid="native-test-connection"
          disabled={(!useOllama && !apiKey.trim()) || test.phase === 'testing' || submitting}
          onClick={() => void handleTest()}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-40"
          style={{
            background: muted(0.06),
            color: 'var(--foreground)',
            border: `1px solid ${muted(0.1)}`,
            cursor: 'pointer',
          }}
        >
          {test.phase === 'testing' ? <Loader2 size={13} className="animate-spin" /> : null}
          Test connection
        </button>
        {test.phase === 'ok' && (
          <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--mint)' }}>
            <Check size={13} /> Key works
          </span>
        )}
        {test.phase === 'fail' && (
          <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--primary)' }}>
            <X size={13} /> {test.message}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-4">
          <FormattedAlert tone="error">{error}</FormattedAlert>
        </div>
      )}

      {/* Footer */}
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          data-testid="native-back"
          onClick={onBack}
          disabled={submitting}
          className="flex items-center gap-1 text-[12px] underline-offset-4 hover:underline disabled:opacity-40"
          style={{
            color: muted(0.5),
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={13} /> Back
        </button>
        <button
          type="button"
          data-testid="native-create-team"
          disabled={!canSubmit || submitting}
          onClick={() => void handleSubmit()}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold transition active:scale-[0.98] disabled:opacity-50"
          style={{
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            cursor: 'pointer',
          }}
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {submitting ? 'Setting up…' : 'Create my team'}
          {!submitting && <ArrowRight size={14} />}
        </button>
      </div>
    </div>
  )
}
