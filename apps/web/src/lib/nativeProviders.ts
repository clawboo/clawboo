// The extra OpenAI-compatible providers the native runtime supports beyond the 4
// primary cards (Anthropic / OpenAI / OpenRouter / Ollama). Rendered as the
// onboarding "More providers" section. The env-var NAMES + provider ids mirror
// the SERVER registry (apps/web/server/lib/runtimes/native/nativeProviders.ts) +
// the adapter's envVarForProvider so a connected key routes + resolves correctly.
//
// `recommendedModel` is a sensible default shown BEFORE a key is entered; once a
// key is present the live `/models` list (GET /api/providers/:id/models) replaces
// it and a valid model is auto-selected, so a slightly-stale default is harmless.

import type { ProviderId } from '@/features/onboarding/ProviderIcon'

export interface NativeMoreProvider {
  /** Must be a ProviderId (has a brand mark in ProviderIcon). */
  id: ProviderId
  name: string
  /** One-line card subtitle. */
  desc: string
  /** API-key input placeholder. */
  placeholder: string
  /** "Get a key" link. */
  keyUrl: string
  /** Vault env-var NAME (mirrors the server registry + adapter). */
  envVar: string
  /** Default model id (native / provider-native format); the live list refines it. */
  recommendedModel: string
  recommendedLabel: string
}

export const NATIVE_MORE_PROVIDERS: NativeMoreProvider[] = [
  {
    id: 'google',
    name: 'Google',
    desc: 'Gemini models',
    placeholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    envVar: 'GEMINI_API_KEY',
    recommendedModel: 'gemini-2.0-flash',
    recommendedLabel: 'Gemini 2.0 Flash',
  },
  {
    id: 'xai',
    name: 'xAI',
    desc: 'Grok models',
    placeholder: 'xai-…',
    keyUrl: 'https://console.x.ai',
    envVar: 'XAI_API_KEY',
    recommendedModel: 'grok-2-latest',
    recommendedLabel: 'Grok 2',
  },
  {
    id: 'groq',
    name: 'Groq',
    desc: 'Fast open models',
    placeholder: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    envVar: 'GROQ_API_KEY',
    recommendedModel: 'llama-3.3-70b-versatile',
    recommendedLabel: 'Llama 3.3 70B',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    desc: 'Mistral models',
    placeholder: 'sk-…',
    keyUrl: 'https://console.mistral.ai/api-keys',
    envVar: 'MISTRAL_API_KEY',
    recommendedModel: 'mistral-large-latest',
    recommendedLabel: 'Mistral Large',
  },
  {
    id: 'together',
    name: 'Together',
    desc: 'Open models',
    placeholder: 'sk-…',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    envVar: 'TOGETHER_API_KEY',
    recommendedModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    recommendedLabel: 'Llama 3.3 70B Turbo',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    desc: 'Fast inference',
    placeholder: 'csk-…',
    keyUrl: 'https://cloud.cerebras.ai',
    envVar: 'CEREBRAS_API_KEY',
    recommendedModel: 'llama-3.3-70b',
    recommendedLabel: 'Llama 3.3 70B',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    desc: 'Kimi models',
    placeholder: 'sk-…',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    envVar: 'MOONSHOT_API_KEY',
    recommendedModel: 'moonshot-v1-32k',
    recommendedLabel: 'Moonshot v1 32K',
  },
]

const MORE_BY_ID = new Map(NATIVE_MORE_PROVIDERS.map((p) => [p.id as string, p]))

/** Look up an extra provider by id (null for a primary / unknown one). */
export function nativeMoreProvider(id: string): NativeMoreProvider | null {
  return MORE_BY_ID.get(id) ?? null
}
