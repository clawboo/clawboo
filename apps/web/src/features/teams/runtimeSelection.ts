/**
 * Pure runtime-selection helpers for CreateTeamModal's PER-AGENT runtime picker.
 *
 * Every agent on a team picks its own runtime — Clawboo Native, OpenClaw, or a
 * connected coding runtime (claude-code / codex / hermes). The server engine runs
 * each member on its own runtime and the universal Boo Zero leads regardless, so
 * there is no single "team runtime". A default ("chef's suggestion") comes from the
 * catalog — a browsable marketplace team suggests OpenClaw; a blank/custom team
 * suggests Clawboo Native — degraded to Native when the suggestion isn't available
 * right now (Gateway down / coding runtime not connected), and overridable per agent.
 */

import type { RuntimeId } from '@/features/runtimes/runtimeCatalog'
import type { RuntimeStatus } from '@clawboo/control-client'

/** Source ids CreateTeamModal can deploy — the RuntimeIds plus OpenClaw. */
export type SelectableSourceId = RuntimeId | 'openclaw'

export interface RuntimeOption {
  sourceId: SelectableSourceId
  label: string
  enabled: boolean
  /** Why the option is disabled — drives the "Connect…" affordance. */
  reason?: string
}

const LABELS: Record<SelectableSourceId, string> = {
  'clawboo-native': 'Clawboo Native',
  openclaw: 'OpenClaw',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  hermes: 'Hermes',
}

/** The three coding runtimes a team member can run on. */
export const CODING_RUNTIME_IDS: readonly RuntimeId[] = ['claude-code', 'codex', 'hermes']

function statusFor(statuses: RuntimeStatus[], id: RuntimeId): RuntimeStatus | undefined {
  return statuses.find((s) => s.id === id)
}

/** Native is available once a provider key is connected (it's the built-in runtime). */
export function nativeAvailable(statuses: RuntimeStatus[]): boolean {
  const s = statusFor(statuses, 'clawboo-native')
  return Boolean(s?.hasCredential) || s?.connectionState === 'ready'
}

/** Availability inputs: the connected runtimes + the OpenClaw Gateway state. */
export interface RuntimeAvailability {
  statuses: RuntimeStatus[]
  openclawConnected: boolean
}

/** Is a resolved sourceId actually deployable right now? OpenClaw needs a live
 *  Gateway; a coding runtime needs a `ready` connect; native needs a provider key. */
export function runtimeAvailable(sid: SelectableSourceId, a: RuntimeAvailability): boolean {
  if (sid === 'openclaw') return a.openclawConnected
  if (sid === 'clawboo-native') return nativeAvailable(a.statuses)
  return statusFor(a.statuses, sid)?.connectionState === 'ready'
}

/** The catalog "chef's suggestion" BEFORE availability degradation. Precedence:
 *  a per-agent suggestion → the team default → the SOURCE RULE (a browsable
 *  marketplace team suggests OpenClaw; a blank/custom team suggests Clawboo Native). */
export function suggestedRuntimeFor(args: {
  agentSuggested?: SelectableSourceId
  teamDefault?: SelectableSourceId
  isMarketplaceTeam: boolean
}): SelectableSourceId {
  return (
    args.agentSuggested ??
    args.teamDefault ??
    (args.isMarketplaceTeam ? 'openclaw' : 'clawboo-native')
  )
}

/** The final SELECTED default = the suggestion, degraded to Clawboo Native when the
 *  suggestion isn't available right now (so a deploy always succeeds). `degradedFrom`
 *  drives the "suggestion unavailable — using Clawboo Native" note in the picker. */
export function resolveDefaultRuntime(
  suggested: SelectableSourceId,
  a: RuntimeAvailability,
): { selected: SelectableSourceId; degradedFrom: SelectableSourceId | null } {
  if (runtimeAvailable(suggested, a)) return { selected: suggested, degradedFrom: null }
  return { selected: 'clawboo-native', degradedFrom: suggested }
}

/** The PER-AGENT runtime options: Clawboo Native + OpenClaw + the three coding
 *  runtimes. OpenClaw is selectable only when the Gateway is connected; a coding
 *  runtime only when its connect state is `ready`. Native is always selectable (the
 *  built-in runtime — if no provider key is connected the deploy surfaces that). */
export function agentRuntimeOptions(
  statuses: RuntimeStatus[],
  openclawConnected: boolean,
): RuntimeOption[] {
  const opts: RuntimeOption[] = [
    { sourceId: 'clawboo-native', label: LABELS['clawboo-native'], enabled: true },
    {
      sourceId: 'openclaw',
      label: LABELS.openclaw,
      enabled: openclawConnected,
      ...(openclawConnected ? {} : { reason: 'Connect an OpenClaw Gateway' }),
    },
  ]
  for (const id of CODING_RUNTIME_IDS) {
    const enabled = statusFor(statuses, id)?.connectionState === 'ready'
    opts.push({
      sourceId: id,
      label: LABELS[id],
      enabled,
      ...(enabled ? {} : { reason: 'Connect in Runtimes' }),
    })
  }
  return opts
}
