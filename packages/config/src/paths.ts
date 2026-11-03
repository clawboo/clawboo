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

export const resolveDefaultHomeDir = (): string => {
  const home = os.homedir()
  if (home) {
    try {
      if (fs.existsSync(home)) return home
    } catch {
      // fall through
    }
  }
  return os.tmpdir()
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
