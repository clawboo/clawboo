// Where Clawboo Native sends each provider's requests: the runs, the key check
// and the model list all ask here, so a provider pointed at a gateway or a
// company proxy (LiteLLM, an egress proxy, a regional endpoint) is reached the
// same way by all three. Before, only Anthropic's and OpenAI's runs could be
// pointed elsewhere (their SDKs read ANTHROPIC_BASE_URL and OPENAI_BASE_URL),
// while the key check and the model list always called the public address, so
// behind a gateway a good key read as bad and the model list came back empty.
//
// Each provider's base URL is an operator setting (lib/operatorSettings): its
// environment variable, else the operator file, else the provider's own
// address. They are read ONCE at startup (`loadProviderBaseUrls`), like the rest
// of the server's configuration. Until then, which only happens in tests and in
// processes that never start the server, the environment alone is read.
//
// A base URL receives the provider's API key with every request, so it is never
// a dashboard setting, and startup warns about one that would send a key over
// plain http to another machine, or that comes from an operator file this
// server's own user (and so every agent it runs) can change.

import {
  effectiveSetting,
  OPERATOR_KEYS,
  OperatorSettingsError,
  type OperatorKey,
} from './operatorSettings'
import { NATIVE_COMPAT_PROVIDERS } from './runtimes/native/nativeProviders'
import { OPENROUTER_BASE_URL } from './runtimes/native/providers/openai'

/** Each provider's operator key. */
const KEY_OF = {
  anthropic: 'anthropicBaseUrl',
  openai: 'openaiBaseUrl',
  openrouter: 'openrouterBaseUrl',
  google: 'googleBaseUrl',
  xai: 'xaiBaseUrl',
  groq: 'groqBaseUrl',
  mistral: 'mistralBaseUrl',
  together: 'togetherBaseUrl',
  cerebras: 'cerebrasBaseUrl',
  moonshot: 'moonshotBaseUrl',
} as const satisfies Record<string, OperatorKey>

export type BaseUrlProvider = keyof typeof KEY_OF

/**
 * The provider's own address, as its SDK or API expects a base URL. Anthropic's
 * is the root (its SDK adds `/v1`); every other one includes its version path.
 */
const DEFAULT_BASE: Record<BaseUrlProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: OPENROUTER_BASE_URL,
  ...(Object.fromEntries(NATIVE_COMPAT_PROVIDERS.map((p) => [p.id, p.baseURL])) as Record<
    Exclude<BaseUrlProvider, 'anthropic' | 'openai' | 'openrouter'>,
    string
  >),
}

export const BASE_URL_PROVIDERS = Object.keys(KEY_OF) as BaseUrlProvider[]

export function isBaseUrlProvider(provider: string): provider is BaseUrlProvider {
  return Object.prototype.hasOwnProperty.call(KEY_OF, provider)
}

/** No trailing slash, so `${base}/models` never doubles one. A loop, not a
 *  regex: a `/+$` pattern slows down badly on a long run of slashes. */
function trimSlash(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}

let loaded: Partial<Record<BaseUrlProvider, string>> | null = null

/**
 * Read every provider's base URL from the operator settings. Call once at
 * startup, after initOperatorSettings has checked them.
 */
export function loadProviderBaseUrls(): void {
  const next: Partial<Record<BaseUrlProvider, string>> = {}
  for (const provider of BASE_URL_PROVIDERS) {
    const value = effectiveSetting(KEY_OF[provider]).value
    if (typeof value !== 'string' || value.trim() === '') continue
    // Paths are added to a base URL as text, by Clawboo and by the providers'
    // SDKs alike, so a query or a fragment would land in the wrong place.
    const url = new URL(value.trim())
    if (url.search || url.hash) {
      throw new OperatorSettingsError(
        `${OPERATOR_KEYS[KEY_OF[provider]].env} must be an address with no query string or ` +
          'fragment (nothing after ? or #).',
      )
    }
    next[provider] = trimSlash(value.trim())
  }
  loaded = next
}

/** Forget what loadProviderBaseUrls read. Tests. */
export function resetProviderBaseUrls(): void {
  loaded = null
}

/**
 * The base URL an administrator set for this provider, or null for its own.
 * Null for a provider this file does not cover, such as Ollama, which has its
 * own `OLLAMA_BASE_URL`.
 */
export function providerBaseUrlOverride(provider: string): string | null {
  if (!isBaseUrlProvider(provider)) return null
  if (loaded) return loaded[provider] ?? null
  const env = process.env[OPERATOR_KEYS[KEY_OF[provider]].env]?.trim()
  return env ? trimSlash(env) : null
}

/** The base URL to reach this provider at: the administrator's, else its own. */
export function providerBaseUrl(provider: BaseUrlProvider): string {
  return providerBaseUrlOverride(provider) ?? DEFAULT_BASE[provider]
}

/** The operator key and environment variable that set a provider's base URL. */
export function baseUrlSettingOf(provider: BaseUrlProvider): { key: OperatorKey; env: string } {
  const key = KEY_OF[provider]
  return { key, env: OPERATOR_KEYS[key].env }
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)
}

/**
 * Startup warnings about the base URLs in force: one that sends a key over
 * plain http to another machine, and settings read from an operator file that
 * `fileReplaceable` says this server's own user can change.
 */
export function providerBaseUrlWarnings(fileReplaceable: () => boolean | null): string[] {
  const warnings: string[] = []
  const fromFile: string[] = []
  for (const provider of BASE_URL_PROVIDERS) {
    const { key, env } = baseUrlSettingOf(provider)
    const setting = effectiveSetting(key)
    if (typeof setting.value !== 'string') continue
    let url: URL
    try {
      url = new URL(setting.value)
    } catch {
      continue
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      warnings.push(
        `SECURITY: ${env} sends the ${provider} API key unencrypted, over plain http to ` +
          `${url.host}. Use https, or a gateway on this computer.`,
      )
    }
    if (setting.source === 'file') fromFile.push(key)
  }
  if (fromFile.length > 0) {
    const replaceable = fileReplaceable()
    const keys = fromFile.join(', ')
    const risk =
      'An agent that can change that file can point a provider at a server of its own, ' +
      'which then receives the API key after the next restart. Keep the file owned by ' +
      "another user, or set the variables in the service's environment instead."
    if (replaceable === true) {
      warnings.push(
        `SECURITY: ${keys} come from an operator file this server's own user can change ` +
          `or replace, and so can every agent it runs. ${risk}`,
      )
    } else if (replaceable === null) {
      warnings.push(
        `SECURITY: ${keys} come from the operator file, and Clawboo cannot check on Windows ` +
          `who can change it. ${risk}`,
      )
    }
  }
  return warnings
}
