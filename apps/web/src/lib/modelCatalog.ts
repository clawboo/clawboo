// ─── Shared model catalog ────────────────────────────────────────────────────
// Factual model IDs per OpenClaw docs (docs.openclaw.ai).
// Format: provider/model-id — OpenClaw splits on the first "/".

export interface ModelOption {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelOption[]
}

export const MODEL_GROUPS: ModelGroup[] = [
  {
    provider: 'Anthropic',
    models: [
      { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    provider: 'OpenAI',
    models: [
      { id: 'openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openai/gpt-5.2', label: 'GPT-5.2' },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'openai/o3-mini', label: 'o3-mini' },
    ],
  },
  {
    provider: 'Google',
    models: [
      { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    ],
  },
  {
    provider: 'OpenRouter',
    models: [
      { id: 'openrouter/openrouter/auto', label: 'Auto (best for prompt)' },
      { id: 'openrouter/anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'openrouter/anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'openrouter/openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openrouter/openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
      { id: 'openrouter/google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'openrouter/google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
      { id: 'openrouter/deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'openrouter/deepseek/deepseek-v3', label: 'DeepSeek V3' },
      { id: 'openrouter/meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
      { id: 'openrouter/meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'openrouter/minimax/minimax-m2.5', label: 'MiniMax M2.5' },
      { id: 'openrouter/mistralai/mistral-large-latest', label: 'Mistral Large' },
      { id: 'openrouter/qwen/qwen3-235b-a22b', label: 'Qwen3 235B' },
      { id: 'openrouter/x-ai/grok-3', label: 'Grok 3' },
      { id: 'openrouter/cohere/command-a', label: 'Cohere Command A' },
      { id: 'openrouter/nousresearch/hermes-3-llama-3.1-405b', label: 'Hermes 3 405B' },
    ],
  },
  {
    provider: 'xAI',
    models: [
      { id: 'xai/grok-3', label: 'Grok 3' },
      { id: 'xai/grok-3-mini', label: 'Grok 3 Mini' },
    ],
  },
  {
    provider: 'Groq',
    models: [
      { id: 'groq/llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'groq/mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
    ],
  },
  {
    provider: 'Mistral',
    models: [{ id: 'mistral/mistral-large-latest', label: 'Mistral Large' }],
  },
  {
    provider: 'Moonshot',
    models: [
      { id: 'moonshot/kimi-k2.5', label: 'Kimi K2.5' },
      { id: 'moonshot/kimi-k2-turbo-preview', label: 'Kimi K2 Turbo' },
      { id: 'moonshot/kimi-k2-thinking', label: 'Kimi K2 Thinking' },
      { id: 'moonshot/kimi-k2-thinking-turbo', label: 'Kimi K2 Thinking Turbo' },
    ],
  },
  {
    provider: 'MiniMax',
    models: [
      { id: 'minimax/MiniMax-M2.5', label: 'MiniMax M2.5' },
      { id: 'minimax/MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' },
    ],
  },
  {
    provider: 'Together',
    models: [
      { id: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
      { id: 'together/deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1' },
      { id: 'together/Qwen/Qwen3-235B-A22B', label: 'Qwen3 235B' },
    ],
  },
  {
    provider: 'NVIDIA',
    models: [{ id: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Llama 3.1 Nemotron 70B' }],
  },
  {
    provider: 'Hugging Face',
    models: [
      { id: 'huggingface/deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1' },
      { id: 'huggingface/Qwen/Qwen3-8B', label: 'Qwen3 8B' },
      { id: 'huggingface/meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B' },
    ],
  },
  {
    provider: 'Z.AI',
    models: [
      { id: 'zai/glm-5', label: 'GLM-5' },
      { id: 'zai/glm-4.7', label: 'GLM-4.7' },
      { id: 'zai/glm-4.6', label: 'GLM-4.6' },
    ],
  },
  {
    provider: 'Cerebras',
    models: [
      { id: 'cerebras/zai-glm-4.7', label: 'GLM-4.7 (Cerebras)' },
      { id: 'cerebras/zai-glm-4.6', label: 'GLM-4.6 (Cerebras)' },
    ],
  },
  {
    provider: 'Venice',
    models: [{ id: 'venice/llama-3.3-70b', label: 'Llama 3.3 70B' }],
  },
  {
    provider: 'Synthetic (Free)',
    models: [
      { id: 'synthetic/MiniMax-M2.5', label: 'MiniMax M2.5' },
      { id: 'synthetic/Kimi-K2-Thinking', label: 'Kimi K2 Thinking' },
      { id: 'synthetic/DeepSeek-R1', label: 'DeepSeek R1' },
    ],
  },
  {
    provider: 'Kimi Coding',
    models: [{ id: 'kimi-coding/k2p5', label: 'K2P5' }],
  },
  {
    provider: 'Xiaomi',
    models: [{ id: 'xiaomi/mimo-v2-flash', label: 'MiMo V2 Flash' }],
  },
  {
    provider: 'Ollama (Local)',
    models: [
      { id: 'ollama/llama3.3', label: 'Llama 3.3' },
      { id: 'ollama/llama3.2', label: 'Llama 3.2' },
      { id: 'ollama/mistral', label: 'Mistral' },
      { id: 'ollama/codellama', label: 'Code Llama' },
      { id: 'ollama/qwen2.5-coder', label: 'Qwen 2.5 Coder' },
      { id: 'ollama/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'ollama/glm-4.7-flash', label: 'GLM-4.7 Flash' },
    ],
  },
  {
    provider: 'vLLM (Local)',
    models: [{ id: 'vllm/custom-model', label: 'Custom Model' }],
  },
  {
    provider: 'SGLang (Local)',
    models: [{ id: 'sglang/custom-model', label: 'Custom Model' }],
  },
]

/** Look up a model's display label by its ID. Returns null for unknown models. */
export function findModelLabel(id: string): string | null {
  for (const group of MODEL_GROUPS) {
    const match = group.models.find((m) => m.id === id)
    if (match) return match.label
  }
  return null
}

/** Find which provider group a model belongs to. Returns the provider name or null. */
export function findProviderForModel(id: string): string | null {
  for (const group of MODEL_GROUPS) {
    if (group.models.some((m) => m.id === id)) return group.provider
  }
  // Fallback: extract provider prefix from ID
  const slashIdx = id.indexOf('/')
  return slashIdx > 0 ? id.slice(0, slashIdx) : null
}
