// Stable per-identity runtime homes under clawboo's own state dir. The runner
// materializes a home path here when a runtime's integration plan resolves to
// `{ kind: 'persistent', scope: 'per-identity' }` — ONE computation point, so
// drivers receive the path through `RuntimeRunContext.homeDir` and never derive
// it themselves.

import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

/**
 * Collapse an agent id to a single safe path segment. Dots are excluded
 * entirely (not just `..`) so traversal is impossible by construction; an
 * empty/missing id falls back to a shared default identity dir.
 */
export function sanitizeAgentId(agentId: string | null | undefined): string {
  return (agentId ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || '_default'
}

/** `<clawboo home>/runtimes/<runtimeId>/<sanitized agentId>` — stable across runs. */
export function runtimeIdentityHomePath(
  runtimeId: string,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveClawbooDir(env),
    'runtimes',
    sanitizeAgentId(runtimeId),
    sanitizeAgentId(agentId),
  )
}
