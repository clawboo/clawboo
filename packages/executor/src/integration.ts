// Native-preservation integration plan. Pure: turns a runtime's declared
// capabilities into the normalized plan the host executes — the host branches
// ONLY on this plan, never on a runtime id. Conservative by default: an absent
// claim resolves to the plain one-shot path (ephemeral home, nothing preserved,
// no gateway routing), so omission never preserves and never strips anything
// beyond what the one-shot path already does.

import type { Capabilities } from './types'

/** Where a run's home lives: a stable per-identity dir that outlives the run,
 *  a throwaway per-run dir, or no host-managed home at all (the runtime is a
 *  connected substrate that owns its own state entirely). */
export type IntegrationHome =
  | { kind: 'persistent'; scope: 'per-identity' }
  | { kind: 'ephemeral' }
  | { kind: 'connected' }

export interface RuntimeIntegrationPlan {
  home: IntegrationHome
  /** Host must keep the home's native skills intact across runs. */
  preserveSkills: boolean
  /** Host must keep the home's native memory intact across runs. */
  preserveMemory: boolean
  /** Deliveries ride the runtime's own live channels (never host-served). */
  useGatewayChannels: boolean
  /** Always false: the host's scheduler owns when-to-run. `nativeScheduler` is
   *  informational and can never opt a runtime into co-running its own cron. */
  coRunScheduler: false
}

export function resolveRuntimeIntegration(caps: Capabilities): RuntimeIntegrationPlan {
  const cls = caps.runtimeClass ?? 'wrapped-oneshot'
  if (cls === 'connected-substrate') {
    // The substrate owns its home/skills/memory entirely — the host manages no
    // filesystem state for it and drives it over its live connection. The
    // preserve flags are operational ("the host must keep this intact"), so
    // they are false here: there is nothing host-managed to preserve.
    return {
      home: { kind: 'connected' },
      preserveSkills: false,
      preserveMemory: false,
      useGatewayChannels: caps.nativeChannels === 'gateway',
      coRunScheduler: false,
    }
  }
  // wrapped-oneshot and native: a persistent home only when claimed
  // per-identity AND persist:true. Preserve flags are CLAMPED to a persistent
  // home — preserving state inside a throwaway home is incoherent, so a
  // misdeclared adapter degrades to the safe default rather than producing a
  // contradictory plan.
  const persistent = caps.nativeHome?.persist === true && caps.nativeHome.scope === 'per-identity'
  return {
    home: persistent ? { kind: 'persistent', scope: 'per-identity' } : { kind: 'ephemeral' },
    preserveSkills: persistent && caps.nativeSkills === 'preserve',
    preserveMemory: persistent && caps.nativeMemory === 'preserve',
    useGatewayChannels: false,
    coRunScheduler: false,
  }
}
