import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { isWindows, resolveShimName } from './platform'

const execFileAsync = promisify(execFile)

export interface ModelOption {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelOption[]
}

interface CliModel {
  key: string
  name: string
  input: string
  contextWindow: number
  local: boolean
  available: boolean
  tags: string[]
}

interface CliOutput {
  count: number
  models: CliModel[]
}

let cachedGroups: ModelGroup[] | null = null
/**
 * Context window per model key, from the same CLI call that builds the groups.
 *
 * WHY THIS IS KEPT. `CliModel.contextWindow` was declared above and then dropped
 * by `transformCliModels`, which builds `{ id, label }` and discards the rest.
 * That number is the one a runtime needs to decide when it is running out of
 * room, and losing it is how an agent ended up compacting against a budget of
 * 32,768 (its model's max OUTPUT tokens) while the model's real window was
 * 204,800. The CLI had the right answer for all 1,069 models the whole time.
 *
 * Kept as a separate map rather than a field on `ModelOption` because there are
 * two structurally identical `ModelOption` declarations in this repo, and adding
 * a field to one of them lands it somewhere nothing reads.
 */
let cachedWindows: Map<string, number> | null = null
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function transformCliModels(models: CliModel[]): ModelGroup[] {
  const map = new Map<string, Map<string, ModelOption>>()
  for (const m of models) {
    const slashIdx = m.key.indexOf('/')
    const provider = slashIdx > 0 ? m.key.slice(0, slashIdx) : 'other'
    if (!map.has(provider)) map.set(provider, new Map())
    const providerMap = map.get(provider)!
    if (!providerMap.has(m.key)) {
      providerMap.set(m.key, { id: m.key, label: m.name || m.key })
    }
  }
  const groups: ModelGroup[] = []
  for (const [provider, modelMap] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const models = [...modelMap.values()].sort((a, b) => a.label.localeCompare(b.label))
    groups.push({ provider, models })
  }
  return groups
}

export async function getModelsFromCli(): Promise<ModelGroup[] | null> {
  const now = Date.now()
  if (cachedGroups && now - cacheTime < CACHE_TTL) return cachedGroups

  try {
    // On Windows, bare 'openclaw' is openclaw.cmd — Node spawn won't resolve
    // the .cmd extension by itself, so use the platform-aware shim name.
    // `shell: isWindows` — Node 18.20.2+ / 20.12.2+ / 22+ refuse to spawn
    // .cmd files without it (CVE-2024-27980 fix). On Unix it's a no-op.
    // `windowsHide: isWindows` — hide the cmd.exe console window that would
    // otherwise flash in front of the dashboard on each model-list refresh.
    const { stdout } = await execFileAsync(
      resolveShimName('openclaw'),
      ['models', 'list', '--all', '--json'],
      {
        timeout: 15_000,
        env: { ...process.env },
        shell: isWindows,
        windowsHide: isWindows,
      },
    )
    const parsed = JSON.parse(stdout) as CliOutput | CliModel[]
    const models = Array.isArray(parsed) ? parsed : parsed.models
    if (!Array.isArray(models) || models.length === 0) return cachedGroups
    cachedGroups = transformCliModels(models)
    cachedWindows = new Map(
      models
        .filter((m) => typeof m.contextWindow === 'number' && m.contextWindow > 0)
        .map((m) => [m.key, m.contextWindow] as const),
    )
    cacheTime = now
    return cachedGroups
  } catch {
    return cachedGroups
  }
}

/**
 * The context window the runtime's own catalog reports for a model, or null.
 *
 * NULL IS A REAL ANSWER, not a reason to substitute a default. A number invented
 * here would be written into a runtime's budget and believed, and a wrong budget
 * is what this exists to prevent: too low makes a runtime compact when it does
 * not need to, too high makes it discover the limit as a provider rejection.
 * Nothing downstream may turn a null into a guess.
 *
 * This is the CONTEXT WINDOW, never the max output tokens. Every registry in
 * this space names those two differently and several conflate them, so the
 * distinction is worth stating at every boundary that carries one.
 */
export async function getContextWindowFromCli(modelKey: string): Promise<number | null> {
  // Populates the cache when cold, and is a no-op when warm.
  await getModelsFromCli()
  return cachedWindows?.get(modelKey) ?? null
}
