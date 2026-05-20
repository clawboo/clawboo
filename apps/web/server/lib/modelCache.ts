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
    const { stdout } = await execFileAsync(
      resolveShimName('openclaw'),
      ['models', 'list', '--all', '--json'],
      {
        timeout: 15_000,
        env: { ...process.env },
        shell: isWindows,
      },
    )
    const parsed = JSON.parse(stdout) as CliOutput | CliModel[]
    const models = Array.isArray(parsed) ? parsed : parsed.models
    if (!Array.isArray(models) || models.length === 0) return cachedGroups
    cachedGroups = transformCliModels(models)
    cacheTime = now
    return cachedGroups
  } catch {
    return cachedGroups
  }
}
