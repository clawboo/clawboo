// Multi-provider routing for the native harness. Candidates = the agent's
// primary provider + its declared fallbacks, each keyed by the conventional
// vault env-var (resolution: per-run apiKeyEnv override → the vault chain).
// HTTP SDK construction cannot fail, so fallback fires PER TURN at first-call
// failure: if the active candidate throws a fallback-worthy error BEFORE
// anything was yielded, the next candidate is tried; once any candidate yields
// it is surfaced as-is (a mid-stream retry would duplicate output). A working
// candidate becomes STICKY for the rest of the conversation, and the sticky
// model feeds cost events so spend is attributed to the provider that actually
// served. (tenant-scoped key resolution is a dormant future seam — keys are
// global today.)

import { envVarForProvider, type AgentConfig } from '@clawboo/adapter-native'

import { resolveRuntimeKey } from '../../secretsVault'
import { createAnthropicProvider } from './providers/anthropic'
import { createOpenAiProvider, ollamaBaseUrl, OPENROUTER_BASE_URL } from './providers/openai'
import {
  isFallbackWorthy,
  normalizeProviderError,
  ProviderError,
  type ProviderClient,
  type ProviderStreamEvent,
  type ProviderTurnParams,
} from './providers/types'

export interface RouteCandidate {
  provider: string
  model: string
  /** null = keyless (ollama). */
  key: string | null
}

export interface RoutedProviderClient {
  /** The model of the candidate that will serve the next turn. */
  activeModel(): string
  activeProvider(): string
  /** Override the active candidate's model (provider stays). */
  setModel(model: string): void
  streamTurn(p: Omit<ProviderTurnParams, 'model'>): AsyncIterable<ProviderStreamEvent>
}

export interface RouteDeps {
  /** Key resolution override (tests). Defaults to the vault chain. */
  resolveKey?: (envVar: string) => string | null
  /** Provider-client factory override (tests). */
  makeProvider?: (candidate: RouteCandidate) => ProviderClient
}

function defaultMakeProvider(c: RouteCandidate): ProviderClient {
  switch (c.provider) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey: c.key ?? '' })
    case 'openai':
      return createOpenAiProvider({ provider: 'openai', apiKey: c.key ?? '' })
    case 'openrouter':
      return createOpenAiProvider({
        provider: 'openrouter',
        apiKey: c.key ?? '',
        baseURL: OPENROUTER_BASE_URL,
      })
    case 'ollama':
      return createOpenAiProvider({
        provider: 'ollama',
        apiKey: 'ollama',
        baseURL: ollamaBaseUrl(),
      })
    default:
      // Unknown provider ids are treated as OpenAI-compatible only when a
      // base URL convention exists for them — there is none, so refuse loudly.
      throw new ProviderError(`unknown provider: ${c.provider}`, 'bad_request')
  }
}

/** Build the ordered, key-resolved candidate list. Keyless non-ollama
 *  candidates are dropped (nothing to authenticate with). */
export function buildCandidates(
  config: AgentConfig,
  apiKeyEnv: Record<string, string> | undefined,
  resolveKey: (envVar: string) => string | null,
): RouteCandidate[] {
  const raw = [
    { provider: config.primaryProvider, model: config.primaryModel, envVar: config.envVar },
    ...(config.fallbacks ?? []).map((f) => ({
      provider: f.provider,
      model: f.model,
      envVar: envVarForProvider(f.provider),
    })),
  ]
  const out: RouteCandidate[] = []
  for (const c of raw) {
    if (c.provider === 'ollama') {
      out.push({ provider: c.provider, model: c.model, key: null })
      continue
    }
    const key = c.envVar ? (apiKeyEnv?.[c.envVar] ?? resolveKey(c.envVar)) : null
    if (key) out.push({ provider: c.provider, model: c.model, key })
  }
  return out
}

export function createRoutedClient(
  config: AgentConfig,
  apiKeyEnv: Record<string, string> | undefined,
  deps: RouteDeps = {},
): RoutedProviderClient {
  const resolveKey = deps.resolveKey ?? resolveRuntimeKey
  const makeProvider = deps.makeProvider ?? defaultMakeProvider
  const candidates = buildCandidates(config, apiKeyEnv, resolveKey)
  const clients = new Map<number, ProviderClient>()
  /** Index of the proven candidate; -1 = none proven yet. */
  let sticky = -1
  /** Per-conversation model override (applies to whichever candidate serves). */
  let modelOverride: string | null = null

  const clientAt = (i: number): ProviderClient => {
    let client = clients.get(i)
    if (!client) {
      client = makeProvider(candidates[i] as RouteCandidate)
      clients.set(i, client)
    }
    return client
  }

  const active = (): { index: number; candidate: RouteCandidate } => {
    const index = sticky >= 0 ? sticky : 0
    return { index, candidate: candidates[index] as RouteCandidate }
  }

  return {
    activeModel(): string {
      if (candidates.length === 0) return config.primaryModel
      return modelOverride ?? active().candidate.model
    },
    activeProvider(): string {
      if (candidates.length === 0) return config.primaryProvider
      return active().candidate.provider
    },
    setModel(model: string): void {
      modelOverride = model
    },
    async *streamTurn(p: Omit<ProviderTurnParams, 'model'>): AsyncIterable<ProviderStreamEvent> {
      if (candidates.length === 0) {
        throw new ProviderError(
          `no provider key available (checked ${config.envVar} and fallbacks)`,
          'auth',
        )
      }
      const start = sticky >= 0 ? sticky : 0
      let lastErr: ProviderError | null = null
      for (let i = start; i < candidates.length; i++) {
        const candidate = candidates[i] as RouteCandidate
        const model = modelOverride ?? candidate.model
        let yielded = false
        try {
          for await (const ev of clientAt(i).streamTurn({ ...p, model })) {
            yielded = true
            sticky = i
            yield ev
          }
          sticky = i
          return
        } catch (err) {
          const pe = normalizeProviderError(err)
          // Output already reached the consumer — surface, never re-run the
          // turn (a retry would duplicate streamed text).
          if (yielded) throw pe
          if (!isFallbackWorthy(pe.code)) throw pe
          lastErr = pe
        }
      }
      throw lastErr ?? new ProviderError('all routing candidates failed', 'unknown')
    },
  }
}
