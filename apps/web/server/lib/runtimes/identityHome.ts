// Stable per-identity runtime homes under clawboo's own state dir. The runner
// materializes a home path here when a runtime's integration plan resolves to
// `{ kind: 'persistent', scope: 'per-identity' }` — ONE computation point, so
// drivers receive the path through `RuntimeRunContext.homeDir` and never derive
// it themselves.

import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

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
 * `<clawboo home>/runtimes/<runtimeId>/<sanitized agentId>`, stable across runs.
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
  const root = path.resolve(resolveClawbooDir(env), 'runtimes')
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  const home = path.resolve(root, sanitizeAgentId(runtimeId), sanitizeAgentId(agentId))
  if (!home.startsWith(prefix)) {
    throw new Error(`runtime identity home escapes ${root}: ${home}`)
  }
  return home
}
