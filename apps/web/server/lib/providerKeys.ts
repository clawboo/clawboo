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
  connected: boolean
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

/** Per-provider connection status. `connected` = present in the vault OR in
 *  OpenClaw's `.env` — never an ambient `process.env` var alone (mirrors the
 *  `hasVaultCredential` distinction), so status reflects a deliberately-set key. */
export function providerStatus(): ProviderStatus[] {
  const stateDir = resolveStateDir()
  return PROVIDER_METAS.map((p) => ({
    id: p.id,
    connected: hasRuntimeSecret(p.envVar) || openclawEnvHasKey(stateDir, p.envVar),
    poweredRuntimes: p.poweredRuntimes,
  }))
}
