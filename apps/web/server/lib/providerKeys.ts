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
import { deleteRuntimeSecret, hasRuntimeSecret, setRuntimeSecret } from './secretsVault'

// Which runtimes a provider key reaches. The vault serves Clawboo Native (for the
// providers it drives directly) + Claude Code (ANTHROPIC_API_KEY) + Hermes
// (OPENROUTER_API_KEY); OpenClaw serves every provider via `.env`. Codex is OAuth
// (never a pasted key), so it's never listed.
const NATIVE_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter'])

function poweredRuntimesFor(provider: string): string[] {
  const runtimes: string[] = []
  if (NATIVE_PROVIDERS.has(provider)) runtimes.push('Clawboo Native')
  if (provider === 'anthropic') runtimes.push('Claude Code')
  if (provider === 'openrouter') runtimes.push('Hermes')
  runtimes.push('OpenClaw')
  return runtimes
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
  poweredRuntimes: poweredRuntimesFor(id),
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
