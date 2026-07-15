// The OpenAI-compatible "extra" providers the native harness can route to,
// beyond the built-in anthropic / openai / openrouter / ollama. Each is reached
// through the shared OpenAI-compatible client with a base-URL override + a bearer
// key (the same mechanism openrouter + ollama already use). This is the routing
// source of truth: the router (routeCall), the live-model fetcher (providerModels),
// and the key health probe (runtimesHealthcheckPOST) all read it. The env-var
// NAMES mirror `@clawboo/adapter-native` envVarForProvider (a test asserts they
// agree) so a connected key lands in — and resolves from — the same vault slot.

export interface NativeCompatProvider {
  id: string
  /** Friendly display name. */
  name: string
  /** OpenAI-compatible base URL (its `/models` + `/chat/completions` live under this). */
  baseURL: string
  /** Vault env-var NAME for this provider's key. */
  envVar: string
}

export const NATIVE_COMPAT_PROVIDERS: NativeCompatProvider[] = [
  {
    id: 'google',
    name: 'Google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVar: 'GEMINI_API_KEY',
  },
  { id: 'xai', name: 'xAI', baseURL: 'https://api.x.ai/v1', envVar: 'XAI_API_KEY' },
  { id: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', envVar: 'GROQ_API_KEY' },
  { id: 'mistral', name: 'Mistral', baseURL: 'https://api.mistral.ai/v1', envVar: 'MISTRAL_API_KEY' },
  {
    id: 'together',
    name: 'Together',
    baseURL: 'https://api.together.xyz/v1',
    envVar: 'TOGETHER_API_KEY',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    envVar: 'CEREBRAS_API_KEY',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    baseURL: 'https://api.moonshot.ai/v1',
    envVar: 'MOONSHOT_API_KEY',
  },
]

const BY_ID = new Map(NATIVE_COMPAT_PROVIDERS.map((p) => [p.id, p]))

/** The OpenAI-compat endpoint for a provider id, or null for a built-in /
 *  unknown one (anthropic / openai / openrouter / ollama are handled directly). */
export function nativeCompatProvider(id: string): NativeCompatProvider | null {
  return BY_ID.get(id) ?? null
}
