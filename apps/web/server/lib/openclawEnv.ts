// Shared helpers for OpenClaw's plaintext key store (`~/.openclaw/.env` + per-agent
// `auth-profiles.json`). The OpenClaw Gateway reads these; clawboo's own runtimes
// read the encrypted vault first and fall back to this `.env` (`resolveRuntimeKey`).
// The Providers hub writes BOTH stores so one key powers every runtime. Extracted
// from system.ts so the provider→env-var map + the `.env`/auth-profiles write format
// have a single source of truth.

import fs from 'node:fs'
import path from 'node:path'

/** Provider id → the env-var name OpenClaw expects in `~/.openclaw/.env`. */
export const ENV_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  together: 'TOGETHER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  huggingface: 'HF_TOKEN',
  cerebras: 'CEREBRAS_API_KEY',
  venice: 'VENICE_API_KEY',
}

/** The env-var name for a provider (falls back to `<PROVIDER>_API_KEY`).
 *  GUARD: keyless OAuth providers (`openai-codex`, the ChatGPT subscription)
 *  must NEVER reach this — the fallback would fabricate an invalid hyphenated
 *  env-var name. Every call site is behind a keyless carve-out (configure /
 *  auto-configure / providers hub), which is what guarantees it. */
export function envVarForOpenclawProvider(provider: string): string {
  return ENV_KEY_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`
}

/** All agent `auth-profiles.json` paths under an OpenClaw state dir. */
export function getAgentAuthProfilePaths(stateDir: string): string[] {
  const paths: string[] = []
  try {
    const agentsDir = path.join(stateDir, 'agents')
    if (!fs.existsSync(agentsDir)) return paths
    for (const agentId of fs.readdirSync(agentsDir)) {
      const profilePath = path.join(agentsDir, agentId, 'agent', 'auth-profiles.json')
      if (fs.existsSync(profilePath)) paths.push(profilePath)
    }
  } catch {
    // Non-fatal
  }
  return paths
}

/**
 * Providers with an OAUTH auth profile (`type: 'oauth'`, or token material with
 * no `key`) across ALL agents' auth-profiles.json — the shape OpenClaw's own
 * `models auth login` writes (e.g. `openai-codex` after a ChatGPT-subscription
 * sign-in). The api-key detector (`detectAuthProfileKeys` in system.ts) requires
 * `provider && key` and so never sees these. Presence/shape ONLY — token values
 * never leave this function. Scans every agent (no first-hit break: profiles are
 * per-agent and an OAuth login may exist on one agent only). Fails CLOSED: an
 * unreadable/misshapen file contributes nothing.
 */
export function detectOauthProfileProviders(stateDir: string): Set<string> {
  const providers = new Set<string>()
  for (const profilePath of getAgentAuthProfilePaths(stateDir)) {
    try {
      const raw = fs.readFileSync(profilePath, 'utf8')
      const data = JSON.parse(raw) as {
        profiles?: Record<
          string,
          { provider?: unknown; type?: unknown; key?: unknown; access?: unknown; refresh?: unknown }
        >
      }
      for (const profile of Object.values(data.profiles ?? {})) {
        if (typeof profile?.provider !== 'string' || !profile.provider) continue
        const isOauthType = profile.type === 'oauth'
        const hasTokenMaterial =
          (typeof profile.access === 'string' && profile.access.length > 0) ||
          (typeof profile.refresh === 'string' && profile.refresh.length > 0)
        if (isOauthType || (hasTokenMaterial && typeof profile.key !== 'string')) {
          providers.add(profile.provider)
        }
      }
    } catch {
      // Fail closed — skip unreadable/misshapen profile files.
    }
  }
  return providers
}

/** Upsert provider keys into `~/.openclaw/.env` + every existing agent's
 *  `auth-profiles.json`. Creates the state dir if missing. Mirrors what OpenClaw's
 *  own config write does. Non-string entries are skipped. */
export function writeOpenclawProviderKeys(stateDir: string, apiKeys: readonly unknown[]): void {
  const entries: { provider: string; key: string }[] = []
  for (const raw of apiKeys) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (typeof e['provider'] === 'string' && typeof e['key'] === 'string') {
      entries.push({ provider: e['provider'], key: e['key'] })
    }
  }
  if (entries.length === 0) return
  fs.mkdirSync(stateDir, { recursive: true })

  // 1) .env upsert.
  const envPath = path.join(stateDir, '.env')
  let envLines: string[] = []
  try {
    envLines = fs.readFileSync(envPath, 'utf8').split('\n')
  } catch {
    // Start fresh
  }
  for (const { provider, key } of entries) {
    const envVarName = envVarForOpenclawProvider(provider)
    const existingIdx = envLines.findIndex((l) => l.trim().startsWith(`${envVarName}=`))
    const newLine = `${envVarName}=${key}`
    if (existingIdx >= 0) envLines[existingIdx] = newLine
    else envLines.push(newLine)
  }
  while (envLines.length > 0 && envLines[envLines.length - 1] === '') envLines.pop()
  fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8')

  // 2) auth-profiles.json for every existing agent.
  const profilePaths = getAgentAuthProfilePaths(stateDir)
  for (const { provider, key } of entries) {
    const profileName = `${provider}:default`
    for (const profilePath of profilePaths) {
      try {
        let data: Record<string, unknown> = {
          version: 1,
          profiles: {},
          lastGood: {},
          usageStats: {},
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            data = parsed as Record<string, unknown>
          }
        } catch {
          // Start fresh
        }
        if (!data['profiles'] || typeof data['profiles'] !== 'object') data['profiles'] = {}
        ;(data['profiles'] as Record<string, unknown>)[profileName] = {
          type: 'api_key',
          provider,
          key,
        }
        if (!data['lastGood'] || typeof data['lastGood'] !== 'object') data['lastGood'] = {}
        ;(data['lastGood'] as Record<string, unknown>)[provider] = profileName
        fs.writeFileSync(profilePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
      } catch {
        // Best-effort per agent
      }
    }
  }
}

/** Remove a provider's key from `~/.openclaw/.env` + clear its auth-profile entry. */
export function removeOpenclawProviderKey(stateDir: string, provider: string): void {
  const envVarName = envVarForOpenclawProvider(provider)
  const envPath = path.join(stateDir, '.env')
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n')
    const filtered = lines.filter((l) => !l.trim().startsWith(`${envVarName}=`))
    while (filtered.length > 0 && filtered[filtered.length - 1] === '') filtered.pop()
    fs.writeFileSync(envPath, filtered.length ? filtered.join('\n') + '\n' : '', 'utf8')
  } catch {
    // No .env → nothing to remove
  }
  const profileName = `${provider}:default`
  for (const profilePath of getAgentAuthProfilePaths(stateDir)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const data = parsed as Record<string, unknown>
      const profiles = data['profiles']
      if (profiles && typeof profiles === 'object') {
        delete (profiles as Record<string, unknown>)[profileName]
      }
      const lastGood = data['lastGood']
      if (
        lastGood &&
        typeof lastGood === 'object' &&
        (lastGood as Record<string, unknown>)[provider] === profileName
      ) {
        delete (lastGood as Record<string, unknown>)[provider]
      }
      fs.writeFileSync(profilePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    } catch {
      // Best-effort
    }
  }
}

/** Whether `~/.openclaw/.env` has a non-empty value for `envVar`. */
export function openclawEnvHasKey(stateDir: string, envVar: string): boolean {
  try {
    const content = fs.readFileSync(path.join(stateDir, '.env'), 'utf8')
    return content
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l.startsWith(`${envVar}=`) && l.slice(envVar.length + 1).trim() !== '')
  } catch {
    return false
  }
}
