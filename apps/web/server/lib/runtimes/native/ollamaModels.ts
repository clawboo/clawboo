// What the local Ollama has actually pulled, read from its native `/api/tags`.
// Runs reach Ollama through its OpenAI-compatible `/v1` path, which answers a
// model it does not have with "model not found" on every run. So the pickers list
// these models, the healthcheck checks the chosen one, and a default that is not
// pulled is swapped for one that is (`pickOllamaModel`).

import { ollamaHasModel } from '@clawboo/db'

import { ollamaBaseUrl } from './providers/openai'

/** The model the docs tell a new user to pull. Also the answer whenever the local
 *  daemon can't be asked or has nothing to offer instead. */
export const OLLAMA_FALLBACK_MODEL = 'llama3.2'

export interface OllamaModel {
  /** The id a run sends: the pulled name with Ollama's implicit `:latest` dropped
   *  (`llama3.2:latest` is `llama3.2`, the name `ollama pull llama3.2` creates). */
  id: string
  /** The name exactly as `/api/tags` lists it. */
  name: string
  /** Whether it can call tools, which agents use on nearly every turn. Null when
   *  this Ollama is too old to report capabilities. */
  tools: boolean | null
  /** When it was pulled or last updated, in ms (0 when unreported). */
  modifiedAt: number
}

export interface OllamaModelList {
  /** False when nothing that speaks Ollama's API answered. */
  reachable: boolean
  /** Chat-capable models, newest first. */
  models: OllamaModel[]
}

/** Ollama's native API root: `OLLAMA_BASE_URL` (or the local default) without the
 *  OpenAI-compatible `/v1` suffix the runtime itself calls. */
export function ollamaApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return ollamaBaseUrl(env).replace(/\/+$/, '').replace(/\/v1$/, '')
}

interface TagEntry {
  name?: unknown
  model?: unknown
  modified_at?: unknown
  details?: { family?: unknown } | null
  capabilities?: unknown
}

// For an Ollama that predates `capabilities` in `/api/tags`: the families the
// embedding models are built on, and the names they ship under.
const EMBEDDING_FAMILIES = new Set(['bert', 'nomic-bert', 'xlm-roberta'])
const EMBEDDING_NAME_RE = /embed|minilm|rerank|(?:^|\/)bge-/i

function capabilitiesOf(entry: TagEntry): string[] | null {
  const caps = entry.capabilities
  if (!Array.isArray(caps) || caps.length === 0) return null
  return caps.filter((c): c is string => typeof c === 'string')
}

/** An embedding model (nomic-embed-text and the like) turns text into vectors and
 *  cannot answer a chat turn, so it can never run an agent. */
function isEmbeddingOnly(entry: TagEntry, name: string): boolean {
  const caps = capabilitiesOf(entry)
  if (caps) return !caps.includes('completion')
  const family = typeof entry.details?.family === 'string' ? entry.details.family : ''
  return EMBEDDING_FAMILIES.has(family.toLowerCase()) || EMBEDDING_NAME_RE.test(name)
}

/** The chat models in an `/api/tags` body, newest first. Null when the body isn't
 *  a tags list at all, so a caller never mistakes another server for an Ollama
 *  with nothing pulled. */
export function parseOllamaTags(body: unknown): OllamaModel[] | null {
  const list = (body as { models?: unknown } | null)?.models
  if (!Array.isArray(list)) return null
  const out: OllamaModel[] = []
  for (const raw of list as TagEntry[]) {
    if (!raw || typeof raw !== 'object') continue
    const name =
      typeof raw.name === 'string' ? raw.name : typeof raw.model === 'string' ? raw.model : ''
    if (!name || isEmbeddingOnly(raw, name)) continue
    const caps = capabilitiesOf(raw)
    const modified = typeof raw.modified_at === 'string' ? Date.parse(raw.modified_at) : NaN
    out.push({
      id: name.replace(/:latest$/, ''),
      name,
      tools: caps ? caps.includes('tools') : null,
      modifiedAt: Number.isFinite(modified) ? modified : 0,
    })
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id))
}

/** Whether `model` is among the pulled models. Ollama reads an untagged name as
 *  `:latest`, so `llama3.2` is met by `llama3.2:latest` but not by `llama3.2:1b`. */
export function ollamaModelPulled(models: readonly OllamaModel[], model: string): boolean {
  return ollamaHasModel(
    models.map((m) => m.name),
    model,
  )
}

/**
 * The model to run: `preferred` when it is pulled, or when nothing is known to be
 * pulled (an unreachable daemon, or one with no chat model, where the UI shows the
 * pull command). Otherwise the newest pulled model that can call tools, then the
 * newest whose tool support is unknown, then the newest of the rest. A model that
 * can't call tools fails any turn that offers it one.
 *
 * Leader and specialist get the same answer on purpose: a local machine holds one
 * or two models in memory, and two different picks would reload a model on nearly
 * every hand-off of a delegation cascade.
 */
export function pickOllamaModel(preferred: string, models: readonly OllamaModel[]): string {
  const [first] = models
  if (!first || ollamaModelPulled(models, preferred)) return preferred
  const rank = (m: OllamaModel): number => (m.tools === true ? 2 : m.tools === null ? 1 : 0)
  let best = first
  for (const m of models) if (rank(m) > rank(best)) best = m
  return best.id
}

/** A picker option: the id, marked when this Ollama says the model can't call tools. */
export function ollamaModelOption(m: OllamaModel): { id: string; label: string } {
  return { id: m.id, label: m.tools === false ? `${m.id} (can't use tools)` : m.id }
}

/** The command that pulls a model, as the UI and run failures print it. */
export function ollamaPullCommand(model: string): string {
  return `ollama pull ${model.replace(/:latest$/, '')}`
}

const PROBE_TIMEOUT_MS = 3000

let cached: { at: number; base: string; list: OllamaModelList } | null = null

async function fetchOllamaModels(base: string): Promise<OllamaModelList> {
  // The timer covers the body read too, so a server that stalls after its
  // headers can't hang a deploy.
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/api/tags`, { signal: ctl.signal })
    if (!res.ok) return { reachable: false, models: [] }
    const models = parseOllamaTags(await res.json().catch(() => null))
    return models ? { reachable: true, models } : { reachable: false, models: [] }
  } catch {
    return { reachable: false, models: [] }
  } finally {
    clearTimeout(timer)
  }
}

/** The pulled chat models. `maxAgeMs` reuses an answer that recent: a team deploy
 *  creates its agents one after another, and an unreachable remote base URL would
 *  otherwise cost the full timeout per agent. Never throws. */
export async function listOllamaModels(opts: { maxAgeMs?: number } = {}): Promise<OllamaModelList> {
  const base = ollamaApiBase()
  const maxAge = opts.maxAgeMs ?? 0
  if (cached && cached.base === base && Date.now() - cached.at < maxAge) return cached.list
  const list = await fetchOllamaModels(base)
  cached = { at: Date.now(), base, list }
  return list
}

export function __resetOllamaModelsCacheForTests(): void {
  cached = null
}
