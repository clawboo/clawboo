// Stable per-identity runtime homes under clawboo's own state dir. The runner
// materializes a home path here when a runtime's integration plan resolves to
// `{ kind: 'persistent', scope: 'per-identity' }` — ONE computation point, so
// drivers receive the path through `RuntimeRunContext.homeDir` and never derive
// it themselves.

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

import { agentMkdir, agentRemove } from '../agentUser/agentFs'
import { isAgentUserMode } from '../agentUser/config'
import { agentHomeDir } from '../agentUser/state'

/** What a collapsed segment is allowed to look like once the rewrite is done. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/

/**
 * Collapse an agent id to a single safe path segment. Dots are excluded
 * entirely (not just `..`) so traversal is impossible by construction; an
 * empty/missing id falls back to a shared default identity dir.
 *
 * The result is checked rather than trusted. The rewrite above is the only thing
 * standing between an id chosen elsewhere and a directory name, so widening its
 * character class later should fail loudly here instead of quietly letting a
 * separator through.
 */
export function sanitizeAgentId(agentId: string | null | undefined): string {
  const segment = (agentId ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || '_default'
  if (!SAFE_SEGMENT_RE.test(segment)) {
    throw new Error(`unsafe path segment derived from ${JSON.stringify(agentId)}`)
  }
  return segment
}

/**
 * Where per-agent runtime state lives.
 *
 * Under the data folder normally. With agents running as their own OS user
 * (CLAWBOO_AGENT_USER), under that user's home instead: the agent user cannot
 * read the data folder, and these homes (CODEX_HOME, HERMES_HOME,
 * CLAUDE_CONFIG_DIR) are the agents' own state, which the runtimes must read and
 * write.
 */
export function runtimeHomesRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (isAgentUserMode(env)) return path.resolve(agentHomeDir(), 'runtimes')
  return path.resolve(resolveClawbooDir(env), 'runtimes')
}

/**
 * `<runtime homes root>/<runtimeId>/<sanitized agentId>`, stable across runs.
 *
 * The assembled path is pinned under the runtimes root with a single startsWith
 * test before it is handed out. The segment rewrite above should make an escape
 * impossible by construction, but this home is created with mkdir and then given
 * to a runtime as its private state directory, so the location itself carries
 * the final say: a path that resolves outside the root is refused here, not
 * discovered later as a directory materialized somewhere it should never be.
 */
export function runtimeIdentityHomePath(
  runtimeId: string,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = runtimeHomesRoot(env)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const home = path.resolve(root, sanitizeAgentId(runtimeId), sanitizeAgentId(agentId))
  if (!home.startsWith(prefix)) {
    throw new Error(`runtime identity home escapes ${root}: ${home}`)
  }
  return home
}

/**
 * A throwaway runtime home, for a run or a check that has no per-identity home
 * (a reviewer run, the Hermes ACP check). `prefix` names it, as for mkdtemp.
 *
 * In the system temp folder normally. With agents on their own OS user, a folder
 * the server made there is the server's (owner-only), so the runtime could not
 * use it: the agent host makes it instead, under the agent user's runtime homes.
 * A dot name there can never be a runtime's own folder (those are sanitized
 * ids). Remove it with `removeThrowawayRuntimeHome`.
 */
export async function makeThrowawayRuntimeHome(prefix: string): Promise<string> {
  if (!isAgentUserMode()) return mkdtemp(path.join(os.tmpdir(), prefix))
  const dir = path.join(
    runtimeHomesRoot(),
    '.throwaway',
    `${prefix}${randomBytes(8).toString('hex')}`,
  )
  await agentMkdir(dir, { mode: 0o700 })
  return dir
}

/** Remove a home `makeThrowawayRuntimeHome` made. Missing is fine. */
export async function removeThrowawayRuntimeHome(dir: string): Promise<void> {
  if (!isAgentUserMode()) {
    await rm(dir, { recursive: true, force: true })
    return
  }
  await agentRemove(dir)
}
