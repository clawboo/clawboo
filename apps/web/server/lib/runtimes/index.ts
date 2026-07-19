// Server-side runtime registry wiring. Builds the non-OpenClaw adapters, each
// wired to its REAL driver factory (Claude Agent SDK / `codex exec` / `hermes`
// CLI / the in-process native harness) and a health check (CLI presence for
// the wrapped runtimes; provider-key presence for built-in native). All
// runtimes are always available; actual usability is determined by install +
// credential state at run time.

import { ClaudeCodeAdapter } from '@clawboo/adapter-claude-code'
import { CodexAdapter } from '@clawboo/adapter-codex'
import { HermesAdapter } from '@clawboo/adapter-hermes'
import { NativeAdapter } from '@clawboo/adapter-native'
import type { HealthResult, RuntimeAdapter } from '@clawboo/executor'

import { resolveRuntimeBin } from '../platform'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { createClaudeCodeDriver } from './claudeCodeDriver'
import { createCodexDriver } from './codexDriver'
import { getDescriptor, NON_OPENCLAW_RUNTIME_IDS, type NonOpenClawRuntimeId } from './descriptor'
import { createHermesDriver } from './hermesDriver'
import { createNativeDriver } from './native'
import type { RuntimeRunContext } from './types'

export type { RuntimeRunContext } from './types'
// Re-export the runtime id surface from the descriptor (single source of truth).
export { NON_OPENCLAW_RUNTIME_IDS, type NonOpenClawRuntimeId } from './descriptor'

/** The non-OpenClaw runtime ids (all always available). */
export function enabledRuntimeIds(): NonOpenClawRuntimeId[] {
  return [...NON_OPENCLAW_RUNTIME_IDS]
}

function cliHealth(bin: string | null): () => Promise<HealthResult> {
  // Resolve via PATH *and* well-known user-install dirs (pip --user / pipx) —
  // Hermes installs to the Python user-site bin, which is off the server's PATH.
  return async () =>
    bin && resolveRuntimeBin(bin)
      ? { ok: true }
      : { ok: false, message: `${String(bin)} not found on PATH or user-install dirs` }
}

/** Native is in-process — health = "can any routable provider key resolve"
 *  (no binary to probe, no network call). Honors the descriptor's FULL env-var
 *  set (envVar + altEnvVars: Anthropic / OpenAI / OpenRouter) so an OpenRouter-only
 *  setup reads healthy, mirroring the connect-state + run-POST key iteration; a
 *  configured OLLAMA_BASE_URL is the keyless-Ollama signal. */
function nativeKeyHealth(): Promise<HealthResult> {
  const d = getDescriptor('clawboo-native')
  const envVars = [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
  const connected =
    envVars.some((v) => Boolean(resolveRuntimeKeyForRuntime('clawboo-native', v))) ||
    Boolean(process.env['OLLAMA_BASE_URL'])
  return Promise.resolve(
    connected
      ? { ok: true }
      : {
          ok: false,
          message: `no provider key connected (${envVars.join(' or ')}, or set OLLAMA_BASE_URL)`,
        },
  )
}

/** Construct an adapter for a runtime, wired to its real driver factory + run context. */
export type RuntimeAdapterFactory = (ctx: RuntimeRunContext) => RuntimeAdapter

export function adapterFactoryFor(id: NonOpenClawRuntimeId): RuntimeAdapterFactory {
  const health = cliHealth(getDescriptor(id).healthBin)
  switch (id) {
    case 'claude-code':
      return (ctx) => new ClaudeCodeAdapter((opts) => createClaudeCodeDriver(opts, ctx), health)
    case 'codex':
      return (ctx) => new CodexAdapter((opts) => createCodexDriver(opts, ctx), health)
    case 'hermes':
      return (ctx) => new HermesAdapter((opts) => createHermesDriver(opts, ctx), health)
    case 'clawboo-native':
      return (ctx) => new NativeAdapter((opts) => createNativeDriver(opts, ctx), nativeKeyHealth)
  }
}

/** Map of runtime id → adapter factory (all non-OpenClaw runtimes). */
export function buildRuntimeAdapterFactories(): Map<NonOpenClawRuntimeId, RuntimeAdapterFactory> {
  const m = new Map<NonOpenClawRuntimeId, RuntimeAdapterFactory>()
  for (const id of enabledRuntimeIds()) m.set(id, adapterFactoryFor(id))
  return m
}
