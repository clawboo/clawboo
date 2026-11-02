import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { resolveStateDir } from '@clawboo/config'

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

/**
 * The agent whose view a model listing takes on a multi-agent OpenClaw. The view
 * differs per agent (it follows that agent's auth: on a live install `main` listed
 * OpenRouter models a team agent without that key did not), so this prefers the
 * agent a person would call the default: an entry marked `default: true`, then
 * `main`, then the first.
 * Reads either roster shape (2026.9's keyed `agents.entries`, or the legacy
 * `agents.list` array). Null when the config names no agent. Pure.
 */
export function pickModelInspectionAgent(config: unknown): string | null {
  const record = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  const agents = record(record(config)?.['agents'])
  const entries = record(agents?.['entries'])
  const rows: { id: string; isDefault: boolean }[] = entries
    ? Object.entries(entries).map(([id, e]) => ({ id, isDefault: record(e)?.['default'] === true }))
    : (Array.isArray(agents?.['list']) ? (agents['list'] as unknown[]) : []).flatMap((e) => {
        const id = record(e)?.['id']
        return typeof id === 'string' && id
          ? [{ id, isDefault: record(e)?.['default'] === true }]
          : []
      })
  const marked = rows.filter((r) => r.isDefault)
  if (marked.length === 1) return marked[0]!.id
  if (rows.some((r) => r.id === 'main')) return 'main'
  return rows[0]?.id ?? null
}

/** OpenClaw 2026.9 refuses a model listing on a multi-agent install that names
 *  no owner: "Multiple agents are configured, but model inspection has no
 *  explicit owner. Pass --agent <id> or set agents.defaults.systemAgent.agentId."
 *  It exits 1, with that message in the JSON on stdout and again on stderr. */
const NO_OWNER_RE = /has no explicit owner/

function refusedForNoOwner(err: unknown): boolean {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown } | null
  return [e?.stdout, e?.stderr, e?.message].some(
    (t) => typeof t === 'string' && NO_OWNER_RE.test(t),
  )
}

function readOpenClawConfig(): unknown {
  try {
    return JSON.parse(readFileSync(path.join(resolveStateDir(), 'openclaw.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Set once this install refused a listing for want of an owner, so later
 *  refreshes pass `--agent` straight away instead of spawning twice. */
let listingNeedsOwner = false

/**
 * `openclaw models list --all --json`, with `--agent` only when OpenClaw asks for
 * it. The flag is never sent unprompted: an install that lists fine without it
 * (one agent, a configured system agent, or a version that predates the rule)
 * runs exactly the command it always did.
 */
async function runModelList(): Promise<string> {
  const run = async (agent: string | null): Promise<string> => {
    // On Windows, bare 'openclaw' is openclaw.cmd — Node spawn won't resolve
    // the .cmd extension by itself, so use the platform-aware shim name.
    // `shell: isWindows` — Node 18.20.2+ / 20.12.2+ / 22+ refuse to spawn
    // .cmd files without it (CVE-2024-27980 fix). On Unix it's a no-op.
    // `windowsHide: isWindows` — hide the cmd.exe console window that would
    // otherwise flash in front of the dashboard on each model-list refresh.
    const { stdout } = await execFileAsync(
      resolveShimName('openclaw'),
      ['models', 'list', '--all', '--json', ...(agent ? ['--agent', agent] : [])],
      {
        timeout: 15_000,
        env: { ...process.env },
        shell: isWindows,
        windowsHide: isWindows,
      },
    )
    return stdout
  }

  // Picked from the current config each time: the remembered fact is that an
  // owner is needed, not which agent, since agents come and go.
  const owner = listingNeedsOwner ? pickModelInspectionAgent(readOpenClawConfig()) : null
  try {
    return await run(owner)
  } catch (err) {
    if (owner) {
      // The flagged call failed for another reason; ask plainly next time.
      listingNeedsOwner = false
      throw err
    }
    if (!refusedForNoOwner(err)) throw err
    const picked = pickModelInspectionAgent(readOpenClawConfig())
    if (!picked) throw err
    listingNeedsOwner = true
    return run(picked)
  }
}

export async function getModelsFromCli(): Promise<ModelGroup[] | null> {
  const now = Date.now()
  if (cachedGroups && now - cacheTime < CACHE_TTL) return cachedGroups

  try {
    const stdout = await runModelList()
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
