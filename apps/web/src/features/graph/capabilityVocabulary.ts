// The words the graph uses for what an agent carries.
//
// ONE VOCABULARY, because the counts under a Boo, the group tiles in its ring,
// the tile names and the screen-reader names all describe the same records. When
// each spelled its own, the canvas contradicted itself: an OpenClaw Boo carrying
// one skill and three connectors read "5 skills · 44 connectors" on its face. The
// 41 extra "connectors" were OpenClaw plugins, and the other four "skills" were
// two Gateway tools, the built-in tool set and the model tile.
//
// Pure: no React and no store, so the node test project can assert it directly.

import type { CapabilityRecord } from '@clawboo/capability-registry'
import type { ProviderId } from '@/features/onboarding/ProviderIcon'
import { normalizeProviderId } from '@/lib/modelProvider'
import { PROVIDER_CATALOG } from '@/lib/providerCatalog'

/**
 * What a capability is, in the words a person reads on the canvas.
 *
 * `plugin` is split out of `connector` although the Gateway reports both as
 * connectors: a plugin extends OpenClaw itself (a model provider, speech, device
 * pairing), while a connector is a service the agent reaches. Counting forty
 * plugins as connectors is what made every OpenClaw Boo look wired to forty
 * services. `builtin` is the one tile that summarizes a runtime's own tool set.
 */
export type CapabilityClass = 'skill' | 'tool' | 'connector' | 'plugin' | 'builtin'

type ClassifiedFields = Pick<CapabilityRecord, 'kind' | 'source' | 'sourceKey'>

/** An OpenClaw plugin. The Gateway source keys each one `plugin:<id>`. */
export function isPluginRecord(cap: ClassifiedFields): boolean {
  return (
    cap.kind === 'connector' &&
    cap.source === 'openclaw-extension' &&
    cap.sourceKey.startsWith('plugin:')
  )
}

export function capabilityClassOf(cap: ClassifiedFields): CapabilityClass {
  if (cap.source === 'runtime-builtin') return 'builtin'
  if (cap.kind === 'connector') return isPluginRecord(cap) ? 'plugin' : 'connector'
  return cap.kind === 'skill' ? 'skill' : 'tool'
}

const NOUN: Record<CapabilityClass, readonly [one: string, many: string]> = {
  skill: ['skill', 'skills'],
  tool: ['tool', 'tools'],
  connector: ['connector', 'connectors'],
  plugin: ['plugin', 'plugins'],
  builtin: ['built-in tool set', 'built-in tool sets'],
}

/** "1 plugin", "41 plugins". */
export function countOf(n: number, cls: CapabilityClass): string {
  const [one, many] = NOUN[cls]
  return `${n} ${n === 1 ? one : many}`
}

/** "1 capability", "47 capabilities": the total on a Boo's face. */
export function capabilityCount(n: number): string {
  return `${n} ${n === 1 ? 'capability' : 'capabilities'}`
}

export type ClassCounts = Partial<Record<CapabilityClass, number>>

// What a person gave the agent reads first; what the runtime brings reads last.
const CLASS_ORDER: readonly CapabilityClass[] = ['skill', 'tool', 'connector', 'plugin', 'builtin']

/** "1 skill, 2 tools, 3 connectors, 41 plugins, built-in tools". Empty when nothing. */
export function describeClassCounts(counts: ClassCounts): string {
  const parts: string[] = []
  for (const cls of CLASS_ORDER) {
    const n = counts[cls] ?? 0
    if (n === 0) continue
    // The rollup is one tile standing for a whole tool set, so a number in front
    // of it ("1 built-in tool set") would count the tile rather than the tools.
    parts.push(cls === 'builtin' ? 'built-in tools' : countOf(n, cls))
  }
  return parts.join(', ')
}

// ─── Names ───────────────────────────────────────────────────────────────────

const PROVIDER_NAME: Partial<Record<ProviderId, string>> = {
  ...Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p.name])),
  ollama: 'Ollama',
  'openai-codex': 'OpenAI Codex',
}

// Words an id spells in lowercase that are written some other way. Only what
// plain title case gets wrong belongs here: acronyms and brand casing.
const WORD: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  cli: 'CLI',
  cua: 'CUA',
  fs: 'FS',
  http: 'HTTP',
  id: 'ID',
  llm: 'LLM',
  mcp: 'MCP',
  pdf: 'PDF',
  sql: 'SQL',
  ssh: 'SSH',
  stt: 'STT',
  tts: 'TTS',
  ui: 'UI',
  url: 'URL',
  xr: 'XR',
  clawrouter: 'ClawRouter',
  elevenlabs: 'ElevenLabs',
  github: 'GitHub',
  gitlab: 'GitLab',
  litellm: 'LiteLLM',
  lmstudio: 'LM Studio',
  opencode: 'OpenCode',
  senseaudio: 'SenseAudio',
  sglang: 'SGLang',
  vllm: 'vLLM',
}

/** The provider a name spells exactly, never through an alias ("gemini-cli" is not Google). */
function providerName(word: string): string | undefined {
  return PROVIDER_NAME[word as ProviderId]
}

/**
 * The name to put on a tile, for a capability whose name is an identifier.
 *
 * Gateway tools, brokered tools and OpenClaw plugins report the key they are
 * called by ("web_search", "sessions_spawn", "device-pair"), and the ring
 * printed it as-is beside tiles reading "Brainstorming". A name that already has
 * a space or a capital was written for a person and is left alone. Display only:
 * installs, lookups and tests keep the raw name, which is what the server knows.
 */
export function humanizeCapabilityName(raw: string): string {
  const name = raw.trim()
  if (name === '' || /\s/.test(name) || /[A-Z]/.test(name)) return name
  const whole = providerName(name)
  if (whole) return whole
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => WORD[w] ?? providerName(w) ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * The model provider an OpenClaw plugin stands for, so its tile can wear that
 * provider's mark instead of a generic glyph. About a quarter of a real Gateway's
 * plugins are providers the app already draws logos for (Anthropic, OpenAI,
 * Google, xAI, ...). Null for every other plugin and for anything not a plugin.
 */
export function pluginProviderId(cap: ClassifiedFields): ProviderId | null {
  if (!isPluginRecord(cap)) return null
  return normalizeProviderId(cap.sourceKey.slice('plugin:'.length))
}
