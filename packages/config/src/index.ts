import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ─── Constants ───────────────────────────────────────────────────────────────

const NEW_STATE_DIRNAME = '.openclaw'
const LEGACY_STATE_DIRNAMES = ['.clawdbot', '.moltbot']
const CLAWBOO_DIRNAME = '.clawboo'
const OPENCLAW_CONFIG_FILENAME = 'openclaw.json'
const DEFAULT_GATEWAY_URL = 'ws://localhost:18789'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClawbooSettings {
  gatewayUrl: string
  gatewayToken: string
  studioAccessToken?: string
  /** Epoch ms the user dismissed the first-run nudge (undefined = not dismissed). */
  firstRunDismissedAt?: number
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

const resolveUserPath = (input: string): string => {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('~')) {
    const expanded = trimmed.replace(/^~(?=$|[/\\])/, os.homedir())
    return path.resolve(expanded)
  }
  return path.resolve(trimmed)
}

const resolveDefaultHomeDir = (): string => {
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

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override =
    env['OPENCLAW_STATE_DIR']?.trim() ||
    env['MOLTBOT_STATE_DIR']?.trim() ||
    env['CLAWDBOT_STATE_DIR']?.trim()

  if (override) return resolveUserPath(override)

  const home = resolveDefaultHomeDir()
  const newDir = path.join(home, NEW_STATE_DIRNAME)
  const legacyDirs = LEGACY_STATE_DIRNAMES.map((dir) => path.join(home, dir))

  try {
    if (fs.existsSync(newDir)) return newDir
  } catch {
    // fall through
  }

  for (const dir of legacyDirs) {
    try {
      if (fs.existsSync(dir)) return dir
    } catch {
      // fall through
    }
  }

  return newDir
}

/**
 * clawboo's OWN state directory — distinct from OpenClaw's (`resolveStateDir`).
 * clawboo owns everything under this dir (the SQLite DB, settings, the secrets
 * vault, worktrees, the proxy device identity, the api-port file, the managed
 * gateway PID). OpenClaw's dir is only ever READ for interop (gateway config +
 * provider-key fallback) — never written by clawboo. `CLAWBOO_HOME` overrides
 * the location (e.g. test sandboxes); otherwise it defaults to `~/.clawboo`.
 */
export function resolveClawbooDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CLAWBOO_HOME']?.trim()
  if (override) return resolveUserPath(override)
  return path.join(resolveDefaultHomeDir(), CLAWBOO_DIRNAME)
}

export function resolveSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveClawbooDir(env), 'settings.json')
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const readJsonFile = (filePath: string): Record<string, unknown> | null => {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

// ─── .env file reader ─────────────────────────────────────────────────────────

/**
 * Read a single variable from a .env file. Returns null if not found.
 * This is needed because openclaw.json uses template tokens like
 * `${GATEWAY_AUTH_TOKEN}` that reference .env values — the Gateway resolves
 * them at runtime, but Clawboo needs the actual value.
 */
const readDotEnvVar = (envFilePath: string, varName: string): string | null => {
  try {
    if (!fs.existsSync(envFilePath)) return null
    const content = fs.readFileSync(envFilePath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const eqIdx = trimmed.indexOf('=')
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      if (key === varName && val) return val
    }
    return null
  } catch {
    return null
  }
}

/**
 * If a token is a template variable like `${GATEWAY_AUTH_TOKEN}`, resolve it
 * from process.env first, then from the .env file in the state directory.
 * Returns the resolved value, or empty string if unresolvable.
 */
const resolveTokenTemplate = (raw: string, stateDir: string, env: NodeJS.ProcessEnv): string => {
  if (!raw.startsWith('${') || !raw.endsWith('}')) return raw
  const varName = raw.slice(2, -1)
  // Process env takes priority (explicit env var override)
  const fromEnv = env[varName]?.trim()
  if (fromEnv) return fromEnv
  // Fall back to .env file
  return readDotEnvVar(path.join(stateDir, '.env'), varName) || ''
}

// ─── OpenClaw config defaults ─────────────────────────────────────────────────

const readOpenclawGatewayDefaults = (
  env: NodeJS.ProcessEnv = process.env,
): { url: string; token: string } | null => {
  try {
    const stateDir = resolveStateDir(env)
    const configPath = path.join(stateDir, OPENCLAW_CONFIG_FILENAME)
    const parsed = readJsonFile(configPath)
    if (!isRecord(parsed)) return null

    const gateway = isRecord(parsed['gateway']) ? parsed['gateway'] : null
    if (!gateway) return null

    const auth = isRecord(gateway['auth']) ? gateway['auth'] : null
    const rawToken = typeof auth?.['token'] === 'string' ? auth['token'].trim() : ''
    const token = resolveTokenTemplate(rawToken, stateDir, env)
    const port =
      typeof gateway['port'] === 'number' && Number.isFinite(gateway['port'])
        ? gateway['port']
        : null

    if (!token) return null
    const url = port ? `ws://localhost:${port}` : ''
    if (!url) return null

    return { url, token }
  } catch {
    return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read a single variable from OpenClaw's `.env` (`<stateDir>/.env`). This is an
 * INTEROP read only — clawboo never writes there. Used as the lowest-priority
 * fallback when resolving a runtime provider key, so an existing OpenClaw
 * provider setup (e.g. `ANTHROPIC_API_KEY`) is reused automatically. Returns the
 * value or null. Single source for `.env` parsing — do not add a second reader.
 */
export function readOpenclawEnvVar(
  varName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readDotEnvVar(path.join(resolveStateDir(env), '.env'), varName)
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): ClawbooSettings {
  const settingsPath = resolveSettingsPath(env)
  const parsed = readJsonFile(settingsPath)
  const gateway = isRecord(parsed?.['gateway']) ? parsed['gateway'] : null

  const url = typeof gateway?.['url'] === 'string' ? gateway['url'].trim() : ''
  const rawToken = typeof gateway?.['token'] === 'string' ? gateway['token'].trim() : ''
  const studioAccessToken =
    typeof parsed?.['studioAccessToken'] === 'string'
      ? parsed['studioAccessToken'].trim()
      : undefined
  const firstRunDismissedAt =
    typeof parsed?.['firstRunDismissedAt'] === 'number' ? parsed['firstRunDismissedAt'] : undefined

  // Resolve template tokens (e.g. "${GATEWAY_AUTH_TOKEN}") that may have
  // leaked into settings.json from openclaw.json's template syntax.
  const stateDir = resolveStateDir(env)
  const token = resolveTokenTemplate(rawToken, stateDir, env)

  // If no usable token, try openclaw.json defaults (which also resolves templates)
  if (!token) {
    const defaults = readOpenclawGatewayDefaults(env)
    if (defaults) {
      return {
        gatewayUrl: url || defaults.url,
        gatewayToken: defaults.token,
        studioAccessToken: studioAccessToken || undefined,
        ...(firstRunDismissedAt !== undefined ? { firstRunDismissedAt } : {}),
      }
    }
  }

  return {
    gatewayUrl: url || DEFAULT_GATEWAY_URL,
    gatewayToken: token,
    studioAccessToken: studioAccessToken || undefined,
    ...(firstRunDismissedAt !== undefined ? { firstRunDismissedAt } : {}),
  }
}

export function saveSettings(
  updates: Partial<ClawbooSettings>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const settingsPath = resolveSettingsPath(env)
  const settingsDir = path.dirname(settingsPath)

  // Ensure directory exists
  fs.mkdirSync(settingsDir, { recursive: true })

  // Read current settings
  const current = readJsonFile(settingsPath) ?? {}

  // Merge gateway settings
  const gateway = isRecord(current['gateway']) ? { ...current['gateway'] } : {}

  if (updates.gatewayUrl !== undefined) gateway['url'] = updates.gatewayUrl
  if (updates.gatewayToken !== undefined) gateway['token'] = updates.gatewayToken

  const next: Record<string, unknown> = {
    ...current,
    gateway,
  }

  if (updates.studioAccessToken !== undefined) {
    next['studioAccessToken'] = updates.studioAccessToken
  }

  if (updates.firstRunDismissedAt !== undefined) {
    next['firstRunDismissedAt'] = updates.firstRunDismissedAt
  }

  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8')
}
