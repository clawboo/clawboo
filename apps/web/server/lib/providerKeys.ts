// The unified provider-key store behind the Settings → Providers hub. Each provider
// key is written to BOTH stores — the encrypted vault (Clawboo Native + Claude Code
// + Hermes) and OpenClaw's `~/.openclaw/.env` (the OpenClaw Gateway) — so a key set
// once powers every runtime. Values are NEVER logged or echoed (secretsVault invariant).

import { resolveStateDir } from '@clawboo/config'

import {
  ENV_KEY_MAP,
  envVarForOpenclawProvider,
  openclawEnvHasKey,
  removeOpenclawProviderKey,
  writeOpenclawProviderKeys,
} from './openclawEnv'
import { getDescriptor, NON_OPENCLAW_RUNTIME_IDS } from './runtimes/descriptor'
import { deleteRuntimeSecret, hasRuntimeSecret, setRuntimeSecret } from './secretsVault'

// Which runtimes a provider key reaches, read off each runtime's descriptor: a
// runtime is listed when the key's env var is one it reads (its `envVar` or an
// `altEnvVars` entry), so this list moves with the runtimes rather than being
// kept by hand. OpenClaw reads every provider from `.env`. Codex is OAuth (never
// a pasted key), so it's never listed.
function poweredRuntimesFor(envVar: string): string[] {
  const runtimes = NON_OPENCLAW_RUNTIME_IDS.map(getDescriptor)
    .filter((d) => d.envVar === envVar || (d.altEnvVars ?? []).includes(envVar))
    .map((d) => d.name)
  return [...runtimes, 'OpenClaw']
}

export interface ProviderStatus {
  id: string
  /** Saved here, or set in the server's environment: either way, runs use it. */
  connected: boolean
  /** In the vault or OpenClaw's `.env`, so Disconnect can remove it. */
  saved: boolean
  /** Set in the environment Clawboo was started with. Runs read it before a
   *  saved key, and nothing here can remove it. */
  fromEnvironment: boolean
  /** The variable that holds the key: a name, never the value. */
  envVar: string
  poweredRuntimes: string[]
}

/** The providers the hub manages, with their env-var slot + "used by" list. */
export const PROVIDER_METAS = Object.keys(ENV_KEY_MAP).map((id) => ({
  id,
  envVar: ENV_KEY_MAP[id]!,
  poweredRuntimes: poweredRuntimesFor(ENV_KEY_MAP[id]!),
}))

export function isKnownProvider(id: string): boolean {
  return id in ENV_KEY_MAP
}

/** Store a provider key in BOTH the encrypted vault and OpenClaw's `.env`. */
export function connectProviderKey(provider: string, apiKey: string): void {
  setRuntimeSecret(envVarForOpenclawProvider(provider), apiKey)
  writeOpenclawProviderKeys(resolveStateDir(), [{ provider, key: apiKey }])
}

/** Remove a provider key from BOTH stores. */
export function disconnectProviderKey(provider: string): void {
  deleteRuntimeSecret(envVarForOpenclawProvider(provider))
  removeOpenclawProviderKey(resolveStateDir(), provider)
}

/** Per-provider connection status. A key the server's environment supplies is
 *  connected too, since runs use it (they read the environment first), but is
 *  marked `fromEnvironment` rather than `saved`: Disconnect cannot remove it, and
 *  the dashboard says where it comes from instead of offering to. */
export function providerStatus(env: NodeJS.ProcessEnv = process.env): ProviderStatus[] {
  const stateDir = resolveStateDir()
  return PROVIDER_METAS.map((p) => {
    const saved = hasRuntimeSecret(p.envVar) || openclawEnvHasKey(stateDir, p.envVar)
    const fromEnvironment = (env[p.envVar]?.trim() ?? '') !== ''
    return {
      id: p.id,
      connected: saved || fromEnvironment,
      saved,
      fromEnvironment,
      envVar: p.envVar,
      poweredRuntimes: p.poweredRuntimes,
    }
  })
}
