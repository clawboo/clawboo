// Native runtime setup: pick a provider, paste a key (or use a local Ollama
// model), optionally test it, then continue to pick a real team. Mirrors
// ConfigureStep's key-input affordance (Eye/EyeOff reveal). The key is written to
// the encrypted vault via the runtime connect route — never directly. This step
// no longer creates a team: real team selection + deployment is the NEXT step
// (the user picks a template from the marketplace and deploys it).

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  X,
} from 'lucide-react'

import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'
import { ProviderIcon } from '../ProviderIcon'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import {
  connectRuntime,
  fetchProviderModelsWithKey,
  healthcheckNativeKey,
  setNativeLeaderModel,
} from '@clawboo/control-client'
import { getKeyUrl } from '@/features/runtimes/runtimeCatalog'
import {
  findNativeModelLabel,
  nativeLeaderModelFor,
  nativeModelGroupsFor,
} from '@/lib/nativeModelCatalog'
import { NATIVE_MORE_PROVIDERS, nativeMoreProvider } from '@/lib/nativeProviders'
import { useOpenRouterModels } from '@/lib/useOpenRouterModels'
import { Select } from '@/features/shared/Select'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

type Provider = 'anthropic' | 'openai' | 'openrouter' | 'ollama'

const PROVIDERS: { id: Exclude<Provider, 'ollama'>; name: string; placeholder: string }[] = [
  { id: 'anthropic', name: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', placeholder: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-…' },
]

/** The provider grid — the three key-based providers plus local Ollama. */
const PROVIDER_CARDS: { id: Provider; name: string; desc: string }[] = [
  { id: 'anthropic', name: 'Anthropic', desc: 'Claude models' },
  { id: 'openai', name: 'OpenAI', desc: 'GPT models' },
  { id: 'openrouter', name: 'OpenRouter', desc: 'Any model, one key' },
  { id: 'ollama', name: 'Ollama', desc: 'Local · no key needed' },
]

type TestState = { phase: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }

export interface ConfigureNativeStepProps {
  /** Fired with the connected provider + chosen model once the key is stored in
   *  the vault. The wizard then advances to real team selection. */
  onConnected: (provider: string, model: string) => void
  /** Back to the welcome step. */
  onBack: () => void
}

export function ConfigureNativeStep({ onConnected, onBack }: ConfigureNativeStepProps) {
  // A non-ollama provider id — one of the primary cards OR an extra ("more") provider.
  const [provider, setProvider] = useState<string>('anthropic')
  const [useOllama, setUseOllama] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The chosen leader model (native-format id). Defaults to the provider's strongest
  // curated pick; the seed uses it for the starter leader AND the universal Boo Zero.
  const [model, setModel] = useState<string>(() => nativeLeaderModelFor('anthropic'))

  const effectiveProvider: string = useOllama ? 'ollama' : provider
  // OpenRouter's model list is fetched live from its public catalog; every OTHER
  // keyed provider (Anthropic, OpenAI, Google, xAI, Groq, …) is fetched live using
  // the JUST-TYPED key (never stored — the same one-shot-fetch precedent as "Test
  // connection"), so the picker shows the real, current model list. Ollama is local.
  const openrouter = useOpenRouterModels()
  const [liveModels, setLiveModels] = useState<{ id: string; label: string }[]>([])

  useEffect(() => {
    // Ollama is local (no list to fetch); OpenRouter has its own keyless public
    // list. Every other provider enumerates its models with the typed key.
    if (useOllama || provider === 'openrouter') {
      setLiveModels([])
      return
    }
    const key = apiKey.trim()
    if (key.length < 20) {
      setLiveModels([]) // wait for a plausibly-complete key before sending it
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchProviderModelsWithKey(provider, key).then((models) => {
        if (!cancelled) setLiveModels(models)
      })
    }, 700)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [provider, apiKey, useOllama])

  // Once a live list loads, ensure a REAL model is selected — the static
  // recommended default for an extra provider may not be a current model id.
  // Self-stabilizing: once `model` is a live id the condition is false, so
  // including `model` in the deps can't loop; a user pick is always in the list.
  useEffect(() => {
    if (liveModels.length > 0 && !liveModels.some((m) => m.id === model)) {
      setModel(liveModels[0]!.id)
    }
  }, [liveModels, model])

  const modelOptions =
    effectiveProvider === 'openrouter'
      ? openrouter.models
      : liveModels.length > 0
        ? liveModels
        : (nativeModelGroupsFor(effectiveProvider)[0]?.models ?? [])
  const modelSelectOptions = useMemo(() => {
    const base = modelOptions.map((m) => ({ value: m.id, label: m.label }))
    // Guarantee the current selection is present so the trigger shows it (the
    // default id can briefly precede the live list, or be a custom id).
    if (model && !base.some((o) => o.value === model)) {
      base.unshift({ value: model, label: findNativeModelLabel(model) ?? model })
    }
    return base
  }, [modelOptions, model])
  const moreProvider = nativeMoreProvider(provider)
  const placeholder =
    moreProvider?.placeholder ?? PROVIDERS.find((p) => p.id === provider)?.placeholder ?? 'sk-…'
  const keyUrl = moreProvider?.keyUrl ?? getKeyUrl(provider)
  const canSubmit = useOllama || apiKey.trim().length > 0

  const resetTest = useCallback(() => setTest({ phase: 'idle' }), [])

  const selectProvider = useCallback((id: string) => {
    if (id === 'ollama') {
      setUseOllama(true)
    } else {
      setUseOllama(false)
      setProvider(id)
    }
    setModel(nativeLeaderModelFor(id)) // switch to the new provider's recommended model
    setTest({ phase: 'idle' })
    setError(null)
  }, [])

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
    // 2. Record the chosen leader model so the universal Boo Zero runs on it
    //    (best-effort — a failure just falls back to the per-provider default).
    if (model) void setNativeLeaderModel(effectiveProvider, model)
    setSubmitting(false)
    // 3. Advance to real team selection (the next step deploys a real team).
    onConnected(effectiveProvider, model)
  }, [canSubmit, submitting, apiKey, effectiveProvider, model, onConnected])

  return (
    <OnboardingScreen
      testId="configure-native-step"
      step="connect"
      steps={NATIVE_STEPS}
      eyebrow="Connect a provider"
      title="Connect your AI provider"
      subtitle="Bring a provider key. It powers Clawboo Native and every runtime on that provider (Claude Code, Hermes, and more). Next, you'll pick and deploy your first team."
      footer={
        <div className="flex items-center justify-between">
          <OnboardingGhost testId="native-back" onClick={onBack} disabled={submitting}>
            <ArrowLeft size={15} /> Back
          </OnboardingGhost>
          <OnboardingPrimary
            testId="native-continue"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || submitting}
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
            {submitting ? 'Connecting…' : 'Continue'}
            {!submitting && <ArrowRight size={16} />}
          </OnboardingPrimary>
        </div>
      }
    >
      {/* Provider cards */}
      <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Provider">
        {PROVIDER_CARDS.map((p) => {
          const active = p.id === 'ollama' ? useOllama : !useOllama && provider === p.id
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`native-provider-${p.id}`}
              onClick={() => selectProvider(p.id)}
              className={[
                'group flex items-center gap-3 rounded-2xl border p-4 text-left',
                'transition-[transform,border-color,box-shadow,background-color] duration-150',
                active
                  ? ''
                  : 'border-border bg-surface hover:-translate-y-px hover:border-foreground/20',
              ].join(' ')}
              style={{
                cursor: 'pointer',
                ...(active
                  ? {
                      borderColor: 'var(--primary)',
                      background: 'rgb(var(--primary-rgb) / 0.05)',
                      boxShadow: '0 0 0 1px var(--primary)',
                    }
                  : { boxShadow: 'var(--shadow-raised)' }),
              }}
            >
              <ProviderIcon id={p.id} size={38} />
              <span className="min-w-0">
                <span
                  className="block truncate text-[14px] font-semibold"
                  style={{ color: 'var(--foreground)' }}
                >
                  {p.name}
                </span>
                <span className="block truncate text-[12px]" style={{ color: muted(0.5) }}>
                  {p.desc}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* More providers — the extra OpenAI-compatible providers native supports,
          each with its own direct key. Collapsed by default to keep the primary
          choices front-and-center. */}
      <div className="mt-3">
        <button
          type="button"
          data-testid="native-more-providers-toggle"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-[13px] font-medium transition-colors hover:border-foreground/25"
          style={{ color: muted(0.6), cursor: 'pointer' }}
        >
          More providers
          <ChevronDown
            size={15}
            style={{ transform: showMore ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
          />
        </button>
        {showMore ? (
          <div
            className="mt-3 grid grid-cols-2 gap-2.5"
            role="radiogroup"
            aria-label="More providers"
          >
            {NATIVE_MORE_PROVIDERS.map((p) => {
              const active = !useOllama && provider === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`native-provider-${p.id}`}
                  onClick={() => selectProvider(p.id)}
                  className={[
                    'group flex items-center gap-2.5 rounded-xl border p-3 text-left',
                    'transition-[transform,border-color,box-shadow,background-color] duration-150',
                    active
                      ? ''
                      : 'border-border bg-surface hover:-translate-y-px hover:border-foreground/20',
                  ].join(' ')}
                  style={{
                    cursor: 'pointer',
                    ...(active
                      ? {
                          borderColor: 'var(--primary)',
                          background: 'rgb(var(--primary-rgb) / 0.05)',
                          boxShadow: '0 0 0 1px var(--primary)',
                        }
                      : { boxShadow: 'var(--shadow-raised)' }),
                  }}
                >
                  <ProviderIcon id={p.id} size={30} />
                  <span className="min-w-0">
                    <span
                      className="block truncate text-[13px] font-semibold"
                      style={{ color: 'var(--foreground)' }}
                    >
                      {p.name}
                    </span>
                    <span className="block truncate text-[11.5px]" style={{ color: muted(0.5) }}>
                      {p.desc}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {/* API key (hidden when using Ollama) */}
      {!useOllama ? (
        <div className="mt-5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="native-api-key-input"
              className="font-mono text-[11px] uppercase tracking-[0.14em]"
              style={{ color: muted(0.5) }}
            >
              API Key
            </label>
            {keyUrl ? (
              <a
                href={keyUrl}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="native-get-key"
                className="inline-flex items-center gap-1 text-[12px] font-medium underline-offset-2 hover:underline"
                style={{ color: 'var(--primary)' }}
              >
                Get a key <ExternalLink size={11} />
              </a>
            ) : null}
          </div>
          <div className="relative">
            <input
              id="native-api-key-input"
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
              className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 pr-11 font-mono text-[14px] text-foreground outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50 placeholder:text-foreground/30"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground/40 transition-colors hover:text-foreground/70"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {/* Test connection */}
          <div className="mt-1 flex items-center gap-3">
            <button
              type="button"
              data-testid="native-test-connection"
              disabled={!apiKey.trim() || test.phase === 'testing' || submitting}
              onClick={() => void handleTest()}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium underline-offset-4 transition-colors hover:underline disabled:no-underline disabled:opacity-40"
              style={{ color: muted(0.55), background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              {test.phase === 'testing' ? <Loader2 size={13} className="animate-spin" /> : null}
              Test connection
            </button>
            {test.phase === 'ok' ? (
              <span className="flex items-center gap-1 text-[13px]" style={{ color: 'var(--mint)' }}>
                <Check size={14} /> Key works
              </span>
            ) : null}
            {test.phase === 'fail' ? (
              <span
                className="flex items-center gap-1 text-[13px]"
                style={{ color: 'var(--primary)' }}
              >
                <X size={14} /> {test.message}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-5 text-[13px] leading-relaxed" style={{ color: muted(0.55) }}>
          No key needed. Clawboo will run your agents on a local Ollama model. Make sure Ollama is
          running before you continue.
        </p>
      )}

      {/* Model — the leader model for this provider (used for the starter team + Boo Zero). */}
      {modelOptions.length > 0 ? (
        <div className="mt-5 flex flex-col gap-2">
          <span
            className="font-mono text-[11px] uppercase tracking-[0.14em]"
            style={{ color: muted(0.5) }}
          >
            Model
          </span>
          <Select
            value={model}
            onChange={setModel}
            options={modelSelectOptions}
            searchable={modelSelectOptions.length > 10}
            searchPlaceholder="Search models…"
          />
          <p className="text-[12px] leading-relaxed" style={{ color: muted(0.45) }}>
            Sets the model for your coordinating lead. The specialists you add default to a faster,
            cheaper model. You can change any agent&rsquo;s model later, and connect more providers
            anytime in Settings &rarr; Providers.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="mt-5">
          <FormattedAlert tone="error">{error}</FormattedAlert>
        </div>
      ) : null}
    </OnboardingScreen>
  )
}
