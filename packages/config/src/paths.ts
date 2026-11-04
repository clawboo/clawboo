import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CLAWBOO_DIRNAME = '.clawboo'

export const resolveUserPath = (input: string): string => {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('~')) {
    const expanded = trimmed.replace(/^~(?=$|[/\\])/, os.homedir())
    return path.resolve(expanded)
  }
  return path.resolve(trimmed)
}

/** The user's own home folder, or null when it is unset or does not exist. */
export const resolveOwnHomeDir = (): string | null => {
  const home = os.homedir()
  if (home) {
    try {
      if (fs.existsSync(home)) return home
    } catch {
      // fall through
    }
  }
  return null
}

/** The home folder, falling back to the shared temp folder when there is none. */
export const resolveDefaultHomeDir = (): string => resolveOwnHomeDir() ?? os.tmpdir()

/**
 * The Clawboo home only when it is one this user owns: `CLAWBOO_HOME`, or
 * `~/.clawboo` under a home folder that exists. Null when it would fall back to
 * the shared temp folder, where another user could create the folder first.
 */
export function resolveOwnClawbooDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['CLAWBOO_HOME']?.trim()) return resolveClawbooDir(env)
  const home = resolveOwnHomeDir()
  return home === null ? null : path.join(home, CLAWBOO_DIRNAME)
}

/**
 * clawboo's OWN state directory, distinct from OpenClaw's (`resolveStateDir`).
 * clawboo owns everything under this dir (the SQLite DB, settings, the secrets
 * vault, worktrees, the proxy device identity, the api-port file, the managed
 * gateway PID, the access token). OpenClaw's dir is only ever READ for interop
 * (gateway config + provider-key fallback) and never written by clawboo.
 * `CLAWBOO_HOME` overrides the location (e.g. test sandboxes); otherwise it
 * defaults to `~/.clawboo`.
 */
export function resolveClawbooDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CLAWBOO_HOME']?.trim()
  if (override) return resolveUserPath(override)
  return path.join(resolveDefaultHomeDir(), CLAWBOO_DIRNAME)
}
