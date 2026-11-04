// Whether a runtime is installed, and the binary that makes it so. One answer
// for the Runtimes panel, the install route and the adapter health check, so
// the three never disagree.

import { resolveRuntimeBin } from '../platform'
import { resolveAgentSdkBinary } from './agentSdkBinary'
import type { RuntimeDescriptor } from './descriptor'

/** Where the binary came from: the runtime's CLI, or an SDK's own binary. */
export type RuntimeBinSource = 'cli' | 'agent-sdk'

export interface RuntimeInstall {
  path: string
  source: RuntimeBinSource
}

/** The SDK's own binary for a runtime whose runs start one, or null. */
export function resolveSdkBinary(d: RuntimeDescriptor): string | null {
  return d.sdkBinary === 'claude-agent-sdk' ? resolveAgentSdkBinary() : null
}

/**
 * The binary that makes `d` installed, or null when there is none. The CLI is
 * found on PATH or in the user-install dirs; a runtime that runs on an SDK's own
 * binary (Claude Code) is also installed when that binary is present, found the
 * way the SDK finds it. A built-in runtime has no binary and is not probed here.
 */
export function resolveRuntimeInstall(d: RuntimeDescriptor): RuntimeInstall | null {
  if (d.healthBin) {
    const cli = resolveRuntimeBin(d.healthBin)
    if (cli) return { path: cli, source: 'cli' }
  }
  const sdk = resolveSdkBinary(d)
  return sdk ? { path: sdk, source: 'agent-sdk' } : null
}
