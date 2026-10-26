// Server-side runtime registry wiring. Builds the non-OpenClaw adapters, each
// wired to its REAL driver factory (Claude Agent SDK / `codex exec` / `hermes`
// CLI / the in-process native harness) and a health check (CLI presence for
// the wrapped runtimes; provider-key presence for built-in native). All
// runtimes are always available; actual usability is determined by install +
// credential state at run time.

import { ClaudeCodeAdapter } from '@clawboo/adapter-claude-code'
import { CodexAdapter } from '@clawboo/adapter-codex'
import { HermesAdapter } from '@clawboo/adapter-hermes'
import { MockAdapter } from '@clawboo/adapter-mock'
import { NativeAdapter } from '@clawboo/adapter-native'
import type { HealthResult, RuntimeAdapter } from '@clawboo/executor'

import { getDb } from '../db'
import { getMcpAttachSecret } from '../mcpAttachSecret'
import { resolveRuntimeBin } from '../platform'
import { resolveRuntimeKeyForRuntime } from '../secretsVault'
import { createClaudeCodeDriver } from './claudeCodeDriver'
import { createCodexDriver } from './codexDriver'
import {
  getDescriptor,
  mockRuntimeEnabled,
  NON_OPENCLAW_RUNTIME_IDS,
  type NonOpenClawRuntimeId,
} from './descriptor'
import { createHermesDriver } from './hermesDriver'
import { createNativeDriver } from './native'
import { isNativeOllamaConnected } from './native/nativeProviderDefaults'
import type { RuntimeRunContext } from './types'

export type { RuntimeRunContext } from './types'
// Re-export the runtime id surface from the descriptor (single source of truth).
export { NON_OPENCLAW_RUNTIME_IDS, type NonOpenClawRuntimeId } from './descriptor'

/**
 * The non-OpenClaw runtime ids. The four real ones are always available; the
 * fault-injection harness appears ONLY behind its env flag, so a normal install
 * never lists it, never offers it in the UI, and never routes work to it.
 */
export function enabledRuntimeIds(): NonOpenClawRuntimeId[] {
  const ids = [...NON_OPENCLAW_RUNTIME_IDS]
  if (mockRuntimeEnabled()) ids.push('clawboo-mock')
  return ids
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
 *  set-up keyless Ollama (`isNativeOllamaConnected`) counts too. */
function nativeKeyHealth(): Promise<HealthResult> {
  const d = getDescriptor('clawboo-native')
  const envVars = [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
  const connected =
    envVars.some((v) => Boolean(resolveRuntimeKeyForRuntime('clawboo-native', v))) ||
    isNativeOllamaConnected()
  return Promise.resolve(
    connected
      ? { ok: true }
      : {
          ok: false,
          message: `no provider key connected (${envVars.join(' or ')}) and no local Ollama set up`,
        },
  )
}

/**
 * Guarantee the attach secret on a run context that will write HTTP attach URLs.
 *
 * The access gate refuses a cookieless /api/mcp/* call that lacks the attach
 * token, and the token comes from this secret. Filled HERE, in the one factory
 * every real driver is built through, rather than left to each caller: a caller
 * that builds a context with no scope (the verification critic does) would
 * otherwise write bare URLs, and on a gated install those 401 and the run loses
 * its Tasks, Memory and Tools servers without a word. Adds no identity, so an
 * unscoped run stays unbound. Native attaches in-process and never needs it.
 */
export function withAttachSecret(ctx: RuntimeRunContext): RuntimeRunContext {
  if (!ctx.mcpBaseUrl || ctx.memoryScope?.attachSecret) return ctx
  return {
    ...ctx,
    memoryScope: { ...(ctx.memoryScope ?? {}), attachSecret: getMcpAttachSecret(getDb()) },
  }
}

/** Construct an adapter for a runtime, wired to its real driver factory + run context. */
export type RuntimeAdapterFactory = (ctx: RuntimeRunContext) => RuntimeAdapter

export function adapterFactoryFor(id: NonOpenClawRuntimeId): RuntimeAdapterFactory {
  const health = cliHealth(getDescriptor(id).healthBin)
  switch (id) {
    case 'claude-code':
      return (ctx) =>
        new ClaudeCodeAdapter((opts) => createClaudeCodeDriver(opts, withAttachSecret(ctx)), health)
    case 'codex':
      return (ctx) =>
        new CodexAdapter((opts) => createCodexDriver(opts, withAttachSecret(ctx)), health)
    case 'hermes':
      return (ctx) =>
        new HermesAdapter((opts) => createHermesDriver(opts, withAttachSecret(ctx)), health)
    case 'clawboo-native':
      return (ctx) => new NativeAdapter((opts) => createNativeDriver(opts, ctx), nativeKeyHealth)
    case 'clawboo-mock':
      // No driver and no run context: the harness synthesizes its whole event
      // stream from directives in the message.
      return () => new MockAdapter()
  }
}

/** Map of runtime id → adapter factory (all non-OpenClaw runtimes). */
export function buildRuntimeAdapterFactories(): Map<NonOpenClawRuntimeId, RuntimeAdapterFactory> {
  const m = new Map<NonOpenClawRuntimeId, RuntimeAdapterFactory>()
  for (const id of enabledRuntimeIds()) m.set(id, adapterFactoryFor(id))
  return m
}
