// The runtime PROVIDER MANAGER — the shared "which LLM keys power this runtime"
// body. Rendered for Clawboo Native (connect body + Manage + the onboarding
// Add-runtimes foundation row), OpenClaw, and Hermes (Manage).
//
// Deliberately TERSE: single-line rows (brand icon + name + state chip), no
// per-row prose — connected keys only. Runtime surfaces NEVER take a new key
// (providers have their own home):
//   • variant "settings" — ONE quiet right-aligned "Add providers →" link that
//     switches the Settings modal to the Providers hub.
//   • variant "onboarding" — strictly READ-ONLY (no add affordance at all): a
//     provider is connected on the PREVIOUS wizard step, reachable via the
//     step's Back button.
//
// "Connected" here means a key EXISTS, not that it still works, so the native
// "Use" reconnect verifies the stored key before handing it to the runtime, and
// offers "Use anyway" when the provider simply can't be reached right now.
//
// Per runtime: native filters to its 10 routable providers and carries the
// default-model pick + the disconnected-state "Use" reconnect; OpenClaw shows
// every hub provider (any key can power a Gateway model); Hermes shows the three
// keys its spawn plan can consume (OpenRouter + the reused Anthropic/OpenAI).
// The ChatGPT row (native only, codex-gated) is honest: the subscription powers
// agents ON the Codex runtime — native can't consume it, so no connect button.
// Changing the default model retro-applies to the native Boo Zero server-side.
//
// Local Ollama (native only) is the one provider picked HERE: it has no key, so
// the Providers hub has nothing to hold for it. Set up, it is an ordinary
// connected row (default model, disconnect) whose model list is what the local
// daemon has actually pulled, with the pull command when the default isn't one of
// them. Not set up, the settings variant offers it as a single "Use" line,
// verified against the local daemon first.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'

import {
  connectRuntime,
  disconnectProvider,
  disconnectRuntime,
  fetchNativeLeaderModel,
  fetchOllamaModels,
  fetchProviderModels,
  fetchProviders,
  healthcheckNativeKey,
  setNativeLeaderModel,
  type ProviderModelOption,
} from '@clawboo/control-client'

import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'
import { ProviderIcon } from '@/features/onboarding/ProviderIcon'
import { ChatGptSignIn } from './ChatGptSignIn'
import {
  NATIVE_CONNECT_PROVIDERS,
  nativeConnectProvider,
  type NativeMoreProvider,
} from '@/lib/nativeProviders'
import { PROVIDER_CATALOG } from '@/lib/providerCatalog'
import {
  nativeLeaderModelFor,
  nativeModelGroupsFor,
  OLLAMA_FALLBACK_MODEL,
} from '@/lib/nativeModelCatalog'
import { useOllamaModels, type OllamaModelsState } from '@/lib/useOllamaModels'
import { confirm } from '@/stores/confirm'
import { useSettingsModalStore } from '@/stores/settingsModal'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

/** Which runtime this body manages providers for. */
export type ProvidersBodyRuntime = 'clawboo-native' | 'openclaw' | 'hermes'

export interface RuntimeProvidersBodyProps {
  /** Defaults to the native runtime (the original host of this body). */
  runtime?: ProvidersBodyRuntime
  /** Whether the native runtime currently reads `ready` (vs disconnected /
   *  needs-auth). Native only — drives the per-row Use (reconnect) action. */
  nativeReady?: boolean
  /** Whether local Ollama is set up for the native runtime (its status's
   *  `ollamaConnected`). Native only: drives the Ollama row. */
  ollamaConnected?: boolean
  /** The Codex runtime's sign-in state — drives the ChatGPT-subscription row. */
  codexReady?: boolean
  /** Fold the ChatGPT subscription into the providers list (as a peer row, not a
   *  separate card) for a runtime that can CONSUME it. Native omits this (its
   *  subscription row is the codexReady-gated informational one below). */
  subscriptionTool?: 'hermes' | 'openclaw'
  /** This runtime already holds the subscription credential. */
  subscriptionConnected?: boolean
  /** The manual terminal command ChatGptSignIn falls back to on failure. */
  subscriptionLoginCommand?: string
  /** Re-probe the host's runtime list after any state-changing action. */
  onChanged?: () => void | Promise<void>
  /** "settings" (default) shows the quiet Providers-hub link; "onboarding" is
   *  strictly read-only (keys are connected on the previous wizard step). */
  variant?: 'settings' | 'onboarding'
}

/** The provider set a runtime's manager lists (still filtered to hub-CONNECTED). */
function providerRowsFor(runtime: ProvidersBodyRuntime): NativeMoreProvider[] {
  if (runtime === 'hermes') {
    // The keys buildHermesSpawnPlan can actually consume.
    const usable = new Set(['openrouter', 'anthropic', 'openai'])
    return NATIVE_CONNECT_PROVIDERS.filter((p) => usable.has(p.id))
  }
  if (runtime === 'openclaw') {
    // Any hub key can power a Gateway model — the full catalog.
    return PROVIDER_CATALOG.map(
      (c) =>
        nativeConnectProvider(c.id) ?? {
          id: c.id,
          name: c.name,
          desc: '',
          placeholder: c.placeholder,
          keyUrl: c.keyUrl ?? '',
          envVar: c.envVar,
          recommendedModel: '',
          recommendedLabel: '',
        },
    )
  }
  return NATIVE_CONNECT_PROVIDERS
}

/** Native's keyless local provider, in the row shape the keyed providers use. */
const OLLAMA_PROVIDER: NativeMoreProvider = {
  id: 'ollama',
  name: 'Ollama',
  desc: 'Local · no key needed',
  placeholder: '',
  keyUrl: '',
  envVar: 'OLLAMA_BASE_URL',
  recommendedModel: OLLAMA_FALLBACK_MODEL,
  recommendedLabel: 'Llama 3.2',
}

/** Ollama reads an untagged name as `:latest`, so the two spell one model. */
function sameOllamaModel(a: string, b: string): boolean {
  return a.replace(/:latest$/, '') === b.replace(/:latest$/, '')
}

export function RuntimeProvidersBody({
  runtime = 'clawboo-native',
  nativeReady = true,
  ollamaConnected = false,
  codexReady,
  subscriptionTool,
  subscriptionConnected,
  subscriptionLoginCommand,
  onChanged,
  variant = 'settings',
}: RuntimeProvidersBodyProps) {
  const isNative = runtime === 'clawboo-native'
  // Hub truth: which providers already hold a key (vault OR OpenClaw .env).
  const [hubConnected, setHubConnected] = useState<Set<string> | null>(null)
  const [leader, setLeader] = useState<{ provider: string | null; model: string | null }>({
    provider: null,
    model: null,
  })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The provider whose stored key just failed its pre-reconnect check — the one
  // failure the user can deliberately override.
  const [verifyFailedId, setVerifyFailedId] = useState<string | null>(null)
  const [modelSaved, setModelSaved] = useState(false)
  // Live per-provider model lists (fetched with the STORED key on expand).
  const [liveModels, setLiveModels] = useState<Record<string, ProviderModelOption[]>>({})
  // Ollama's pulled models, asked for whenever its row is opened (a pull since
  // the last look shows up without a reload).
  const ollamaExpanded = isNative && ollamaConnected && expandedId === OLLAMA_PROVIDER.id
  const ollama = useOllamaModels(ollamaExpanded)

  const refresh = useCallback(async (): Promise<void> => {
    const [providers, leaderModel] = await Promise.all([
      fetchProviders(),
      // The default-model pick is a NATIVE concept (the Boo Zero leader model);
      // OpenClaw/Hermes manage models elsewhere (openclaw.json / per-agent).
      isNative ? fetchNativeLeaderModel() : Promise.resolve({ provider: null, model: null }),
    ])
    setHubConnected(new Set(providers.filter((p) => p.connected).map((p) => p.id)))
    setLeader(leaderModel)
  }, [isNative])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const rows = useMemo(
    () => [
      ...providerRowsFor(runtime).filter((p) => hubConnected?.has(p.id)),
      ...(isNative && ollamaConnected ? [OLLAMA_PROVIDER] : []),
    ],
    [runtime, hubConnected, isNative, ollamaConnected],
  )
  function toggleExpand(id: string): void {
    setError(null)
    setExpandedId((cur) => (cur === id ? null : id))
  }

  /** Model options for a connected provider's Default-model dropdown: the live
   *  `/models` list (stored key) once fetched, else the static catalog picks. */
  function modelOptionsFor(id: string): ProviderModelOption[] {
    if (id === OLLAMA_PROVIDER.id && ollama.models.length > 0) return ollama.models
    const live = liveModels[id]
    if (live && live.length > 0) return live
    return nativeModelGroupsFor(id).flatMap((g) =>
      g.models.map((m) => ({ id: m.id, label: m.label })),
    )
  }

  /** The Default-model options, always including the stored model: the Select
   *  shows its first option for a value it can't find, which would pass off a
   *  model Ollama doesn't have as one it does. */
  function selectOptionsFor(
    id: string,
    current: string | null,
  ): { value: string; label: string }[] {
    const options = modelOptionsFor(id).map((m) => ({ value: m.id, label: m.label }))
    if (id !== OLLAMA_PROVIDER.id || !current || options.some((o) => o.value === current)) {
      return options
    }
    const missing = ollama.reachable === true && !ollamaHas(current)
    return [{ value: current, label: missing ? `${current} (not pulled)` : current }, ...options]
  }

  function ollamaHas(model: string): boolean {
    return ollama.models.some((m) => sameOllamaModel(m.id, model))
  }

  async function loadLiveModels(id: string): Promise<void> {
    if (liveModels[id]) return
    const models = await fetchProviderModels(id)
    if (models.length > 0) setLiveModels((cur) => ({ ...cur, [id]: models }))
  }

  /** Keyless reconnect with a key the hub already holds (no re-paste). */
  async function handleUse(p: NativeMoreProvider, opts?: { skipVerify?: boolean }): Promise<void> {
    setBusyId(p.id)
    setError(null)
    setVerifyFailedId(null)
    // The stored key may have been revoked since it was saved — "Connected" here
    // means "a key exists", not "a key works". Probe it (keyless: the healthcheck
    // reads the stored key itself) before handing the runtime a dead credential.
    if (!opts?.skipVerify) {
      const h = await healthcheckNativeKey(p.id, '')
      if (!h.ok) {
        setBusyId(null)
        setError(
          p.id === 'ollama'
            ? "Ollama isn't answering on this machine. Start it (ollama serve) and try again."
            : `${p.name}: ${h.error ?? 'could not verify the saved key.'}`,
        )
        setVerifyFailedId(p.id)
        return
      }
    }
    const r = await connectRuntime('clawboo-native', '', p.id)
    if (!r.ok) {
      setBusyId(null)
      setError(r.error ?? 'Failed to reconnect')
      return
    }
    await Promise.all([refresh(), onChanged?.()])
    setBusyId(null)
  }

  /** Per-provider disconnect — removes THIS provider's key from both stores
   *  (vault + OpenClaw .env), leaving the others untouched. Ollama has no key, so
   *  for it this removes the native runtime's Ollama choice instead. */
  async function handleDisconnectKey(p: NativeMoreProvider): Promise<void> {
    const isOllama = p.id === 'ollama'
    if (
      !(await confirm({
        title: `Disconnect ${p.name}?`,
        message: isOllama
          ? 'Clawboo Native stops using your local Ollama. Your providers keep their keys.'
          : `This removes the ${p.name} key from the vault and OpenClaw's .env. Other providers keep their keys.`,
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
    ) {
      return
    }
    setBusyId(p.id)
    setError(null)
    const r = isOllama
      ? await disconnectRuntime('clawboo-native', 'ollama')
      : await disconnectProvider(p.id)
    if (!r.ok) {
      setBusyId(null)
      setError(r.error ?? 'Failed to disconnect')
      return
    }
    await Promise.all([refresh(), onChanged?.()])
    setBusyId(null)
  }

  async function handleMakeDefault(p: NativeMoreProvider): Promise<void> {
    setBusyId(p.id)
    setError(null)
    // Ollama's default is one it has pulled: the model a new agent would get.
    const model =
      p.id === OLLAMA_PROVIDER.id
        ? ((await fetchOllamaModels()).recommendedModel ?? p.recommendedModel)
        : nativeLeaderModelFor(p.id) || p.recommendedModel
    const ok = await setNativeLeaderModel(p.id, model)
    if (ok) setLeader({ provider: p.id, model })
    else setError('Could not set the default provider')
    setBusyId(null)
  }

  async function handleModelChange(p: NativeMoreProvider, model: string): Promise<void> {
    setLeader({ provider: p.id, model })
    const ok = await setNativeLeaderModel(p.id, model)
    if (ok) {
      setModelSaved(true)
      setTimeout(() => setModelSaved(false), 1600)
    } else {
      setError('Could not save the default model')
    }
  }

  const loading = hubConnected === null
  const showChatGpt = isNative && !!codexReady
  // openclaw / hermes can CONSUME the subscription — it's a peer provider row here
  // (connected / addable / needs-codex), never a special card above the list.
  const showSubscription = !!subscriptionTool
  const empty = !loading && rows.length === 0 && !showChatGpt && !showSubscription

  // Onboarding is read-only: with nothing to show, show NOTHING (the previous
  // wizard step owns connecting; an empty card pointing at a hub that isn't
  // reachable mid-wizard would be a dead end).
  if (variant === 'onboarding' && empty) return null

  // Local Ollama not set up: the one provider this body turns on itself (settings
  // only; onboarding picks it on the connect step). "Use" checks the local daemon
  // answers first, with "Use anyway" for one that is simply not running yet.
  const ollamaBusy = busyId === OLLAMA_PROVIDER.id
  const ollamaOffer =
    isNative && variant === 'settings' && !ollamaConnected && !loading ? (
      <div
        data-testid="native-provider-ollama-offer"
        className="flex items-center gap-2.5 px-3 py-2.5"
      >
        <ProviderIcon id="ollama" size={18} />
        <span className="truncate text-[12.5px] font-semibold text-foreground">
          {OLLAMA_PROVIDER.name}
        </span>
        <span className="truncate text-[11px]" style={{ color: muted(0.45) }}>
          {OLLAMA_PROVIDER.desc}
        </span>
        <span className="flex-1" />
        <Button
          variant={nativeReady ? 'secondary' : 'primary'}
          size="sm"
          disabled={ollamaBusy}
          data-testid="native-provider-use-ollama"
          onClick={() => void handleUse(OLLAMA_PROVIDER)}
          className="shrink-0"
        >
          {ollamaBusy ? 'Connecting…' : 'Use'}
        </Button>
        {verifyFailedId === OLLAMA_PROVIDER.id && (
          <Button
            variant="ghost"
            size="sm"
            disabled={ollamaBusy}
            data-testid="native-provider-use-anyway-ollama"
            onClick={() => void handleUse(OLLAMA_PROVIDER, { skipVerify: true })}
            className="shrink-0"
          >
            Use anyway
          </Button>
        )}
      </div>
    ) : null

  return (
    <div className="flex flex-col gap-2" data-testid="native-providers-body">
      <span
        className="font-mono text-[10px] uppercase tracking-widest"
        style={{ color: muted(0.5) }}
      >
        LLM providers
      </span>

      {error && <FormattedAlert tone="error">{error}</FormattedAlert>}

      {loading ? (
        <div
          className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-3 text-[12px]"
          style={{ color: muted(0.45) }}
        >
          <Spinner size={13} /> Checking your providers…
        </div>
      ) : empty ? (
        <>
          {/* Nothing connected yet: the hub is where keys are added; say so plainly. */}
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-3"
            data-testid="native-providers-empty"
          >
            <span className="text-[12px]" style={{ color: muted(0.55) }}>
              No providers connected yet.
            </span>
            <ProvidersLink label="Open Providers" />
          </div>
          {ollamaOffer && (
            <div className="overflow-hidden rounded-xl border border-border">{ollamaOffer}</div>
          )}
        </>
      ) : (
        (rows.length > 0 || showChatGpt || showSubscription) && (
          <div className="flex flex-col overflow-hidden rounded-xl border border-border">
            {rows.map((p, i) => {
              const isDefault = isNative && leader.provider === p.id
              const expanded = expandedId === p.id
              const busy = busyId === p.id
              return (
                <div
                  key={p.id}
                  data-testid={`native-provider-row-${p.id}`}
                  className={i > 0 ? 'border-t border-border' : ''}
                >
                  {/* Single-line row — an expand button + (when reconnectable) a
                      SIBLING Use button, never nested (invalid HTML + a11y trap). */}
                  <div className="flex items-center gap-2.5 pr-3 transition-colors hover:bg-foreground/[0.03]">
                    <button
                      type="button"
                      onClick={() => {
                        toggleExpand(p.id)
                        // Ollama's models live on the local daemon, not the hub.
                        if (isNative && p.id !== OLLAMA_PROVIDER.id) void loadLiveModels(p.id)
                      }}
                      aria-expanded={expanded}
                      data-testid={`native-provider-toggle-${p.id}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-none bg-transparent px-3 py-2.5 text-left"
                    >
                      <ProviderIcon id={p.id} size={18} />
                      <span className="truncate text-[12.5px] font-semibold text-foreground">
                        {p.name}
                      </span>
                      {isDefault && (
                        <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-foreground/55">
                          Default
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wider text-mint">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
                        Connected
                      </span>
                    </button>
                    {isNative && !nativeReady && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy}
                          data-testid={`native-provider-use-${p.id}`}
                          onClick={() => void handleUse(p)}
                          className="shrink-0"
                        >
                          {busy ? 'Connecting…' : 'Use'}
                        </Button>
                        {/* The saved key didn't answer — offer the deliberate
                            override, since the provider may just be unreachable
                            from here right now. */}
                        {verifyFailedId === p.id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            data-testid={`native-provider-use-anyway-${p.id}`}
                            onClick={() => void handleUse(p, { skipVerify: true })}
                            className="shrink-0"
                          >
                            Use anyway
                          </Button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Expanded body — native's default-model pick + disconnect. */}
                  {expanded && (
                    <div className="flex flex-col gap-2 border-t border-border bg-foreground/[0.02] px-3.5 py-3">
                      {isNative && (
                        <div className="flex flex-col gap-1">
                          <span
                            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest"
                            style={{ color: muted(0.5) }}
                          >
                            Default model
                            {modelSaved && isDefault && (
                              <span className="flex items-center gap-0.5 normal-case tracking-normal text-mint">
                                <Check size={10} /> Saved
                              </span>
                            )}
                          </span>
                          {isDefault ? (
                            <Select
                              size="sm"
                              searchable={modelOptionsFor(p.id).length > 12}
                              value={leader.model ?? ''}
                              onChange={(m) => void handleModelChange(p, m)}
                              aria-label={`${p.name} default model`}
                              data-testid={`native-provider-model-${p.id}`}
                              options={selectOptionsFor(p.id, leader.model)}
                            />
                          ) : (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              data-testid={`native-provider-make-default-${p.id}`}
                              onClick={() => void handleMakeDefault(p)}
                              className="self-start"
                            >
                              Make default
                            </Button>
                          )}
                          {p.id === OLLAMA_PROVIDER.id && (
                            <OllamaModelNotice
                              ollama={ollama}
                              model={isDefault ? leader.model : null}
                            />
                          )}
                        </div>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        data-testid={`native-provider-disconnect-${p.id}`}
                        onClick={() => void handleDisconnectKey(p)}
                        className="self-start text-foreground/50"
                      >
                        Disconnect {p.name}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}

            {ollamaOffer && (
              <div className={rows.length > 0 ? 'border-t border-border' : ''}>{ollamaOffer}</div>
            )}

            {/* ChatGPT subscription — shown only once it IS connected. Honest:
                it powers agents ON the Codex runtime; native can't consume it. */}
            {showChatGpt && (
              <div
                data-testid="native-provider-row-chatgpt"
                className={`flex items-center gap-2.5 px-3 py-2.5 ${rows.length > 0 || ollamaOffer ? 'border-t border-border' : ''}`}
              >
                <ProviderIcon id="openai" size={18} />
                <span className="truncate text-[12.5px] font-semibold text-foreground">
                  ChatGPT subscription
                </span>
                <span className="flex-1" />
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wider text-mint">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
                  Connected · Codex
                </span>
              </div>
            )}

            {/* ChatGPT subscription (openclaw / hermes) — a peer provider row, not
                a separate card. Connected → a chip; addable (Codex connected) →
                the inline sign-in; Codex missing → a quiet prerequisite note. */}
            {showSubscription && subscriptionTool && (
              <div className={rows.length > 0 ? 'border-t border-border' : ''}>
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <ProviderIcon id="openai" size={18} />
                  <span className="truncate text-[12.5px] font-semibold text-foreground">
                    ChatGPT subscription
                  </span>
                  <span className="flex-1" />
                  {subscriptionConnected ? (
                    <span
                      data-testid={`runtime-${subscriptionTool}-subscription-connected`}
                      className="flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wider text-mint"
                    >
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-mint" />
                      Connected
                    </span>
                  ) : !codexReady ? (
                    <span
                      data-testid={`runtime-${subscriptionTool}-subscription-needs-codex`}
                      className="shrink-0 text-[11px]"
                      style={{ color: muted(0.45) }}
                    >
                      Connect Codex first
                    </span>
                  ) : null}
                </div>
                {!subscriptionConnected && codexReady && (
                  <div
                    data-testid={`runtime-${subscriptionTool}-subscription-add`}
                    className="border-t border-border bg-foreground/[0.02] px-3.5 py-3"
                  >
                    <ChatGptSignIn
                      tool={subscriptionTool}
                      loginCommand={subscriptionLoginCommand ?? ''}
                      onLoggedIn={() => void onChanged?.()}
                      label="Sign in with ChatGPT"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )
      )}

      {/* Settings: ONE quiet way to add — the Providers hub. */}
      {variant === 'settings' && !loading && !empty && (
        <div className="flex justify-end">
          <ProvidersLink label="Add providers" />
        </div>
      )}
    </div>
  )
}

/** What the Ollama row's model list can't say by itself: the daemon isn't
 *  answering, it has no chat model, or the default model isn't pulled. Each comes
 *  with the command that fixes it and a way to check again afterwards. */
function OllamaModelNotice({ ollama, model }: { ollama: OllamaModelsState; model: string | null }) {
  if (!ollama.loaded || ollama.reachable === null) return null
  let message: string
  let command: string
  if (ollama.reachable === false) {
    message = "Ollama isn't answering, so its models can't be listed. Start it, then check again."
    command = 'ollama serve'
  } else if (ollama.models.length === 0) {
    message = "Ollama is running, but has no chat model yet. Embedding models can't run agents."
    command = `ollama pull ${OLLAMA_FALLBACK_MODEL}`
  } else if (model && !ollama.models.some((m) => sameOllamaModel(m.id, model))) {
    message = `Ollama doesn't have ${model} yet, so runs on it will fail. Pull it, or pick a model it has.`
    command = `ollama pull ${model.replace(/:latest$/, '')}`
  } else {
    return null
  }
  return (
    <div data-testid="native-provider-ollama-notice" className="mt-1 flex flex-col gap-1.5">
      <span className="text-[11.5px] leading-relaxed" style={{ color: muted(0.6) }}>
        {message}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="rounded-md border border-border px-2 py-1 font-mono text-[11.5px]"
          style={{ background: 'var(--code-block-bg)', color: 'var(--foreground)' }}
        >
          {command}
        </code>
        <Button
          variant="ghost"
          size="sm"
          disabled={ollama.checking}
          data-testid="native-provider-ollama-check-again"
          onClick={() => void ollama.refresh()}
        >
          {ollama.checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </div>
  )
}

/** The one navigation affordance out of this body — jump to Settings → Providers
 *  (the modal is already open; this just switches its view). */
function ProvidersLink({ label }: { label: string }) {
  return (
    <button
      type="button"
      data-testid="native-providers-open-hub"
      onClick={() => useSettingsModalStore.getState().openSettings('providers')}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11.5px] font-medium transition-colors hover:text-foreground"
      style={{ color: muted(0.5) }}
    >
      {label} <ArrowRight size={11} />
    </button>
  )
}
