// The client-side provider catalog for the Settings → Providers hub. Ids + env-vars
// match the server's ENV_KEY_MAP (openclawEnv.ts); brand tiles come from ProviderIcon.
// Ollama is keyless (local base-URL) so it isn't a connectable card here.

import type { ProviderId } from '@/features/onboarding/ProviderIcon'

export interface ProviderCatalogEntry {
  id: ProviderId
  name: string
  envVar: string
  placeholder: string
  keyUrl?: string
  /** `primary` shown up front; `more` behind a "More providers" toggle. */
  tier: 'primary' | 'more'
}

// Order is presentation order: OpenAI + OpenRouter lead (the most-used), then the
// rest of the primary tier, then the `more` tier behind the toggle.
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    tier: 'primary',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    placeholder: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    tier: 'primary',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    tier: 'primary',
  },
  {
    id: 'google',
    name: 'Google',
    envVar: 'GEMINI_API_KEY',
    placeholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    tier: 'primary',
  },
  {
    id: 'xai',
    name: 'xAI',
    envVar: 'XAI_API_KEY',
    placeholder: 'xai-…',
    keyUrl: 'https://console.x.ai',
    tier: 'primary',
  },
  {
    id: 'groq',
    name: 'Groq',
    envVar: 'GROQ_API_KEY',
    placeholder: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    tier: 'primary',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envVar: 'MISTRAL_API_KEY',
    placeholder: 'M…',
    keyUrl: 'https://console.mistral.ai/api-keys',
    tier: 'primary',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    envVar: 'MOONSHOT_API_KEY',
    placeholder: 'sk-…',
    tier: 'more',
  },
  { id: 'minimax', name: 'MiniMax', envVar: 'MINIMAX_API_KEY', placeholder: 'eyJh…', tier: 'more' },
  { id: 'together', name: 'Together', envVar: 'TOGETHER_API_KEY', placeholder: '', tier: 'more' },
  { id: 'nvidia', name: 'NVIDIA', envVar: 'NVIDIA_API_KEY', placeholder: 'nvapi-…', tier: 'more' },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    envVar: 'HF_TOKEN',
    placeholder: 'hf_…',
    keyUrl: 'https://huggingface.co/settings/tokens',
    tier: 'more',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    envVar: 'CEREBRAS_API_KEY',
    placeholder: 'csk-…',
    tier: 'more',
  },
  { id: 'venice', name: 'Venice', envVar: 'VENICE_API_KEY', placeholder: 'vapi_…', tier: 'more' },
]
