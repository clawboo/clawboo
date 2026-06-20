// The unified-scheduler singleton: ONE multiplexer over exactly TWO sources.
// (1) ClawbooRoutineScheduleSource — team-task cron (the Routines ledger) for
//     every runtime class. domain:'team-task', managed.
// (2) OpenClawGatewayCronScheduleSource — the OpenClaw agent's own-life cron
//     via the operator WS-RPC. domain:'runtime-own-life', external-write.
// There is deliberately NO third source: Claude Code / Codex / Hermes / native
// have no live native scheduler — scheduling them IS a clawboo Routine (and
// `hermes gateway` is never launched).

import { ScheduleMultiplexer } from '@clawboo/scheduler'

import { getRegistry } from '../agentSource'
import { getDbPath } from '../db'
import { ClawbooRoutineScheduleSource } from './clawbooRoutineScheduleSource'
import { OpenClawGatewayCronScheduleSource } from './openClawGatewayCronScheduleSource'

let singleton: ScheduleMultiplexer | null = null

export function getScheduleMultiplexer(): ScheduleMultiplexer {
  if (!singleton) {
    singleton = new ScheduleMultiplexer()
    singleton.register(new ClawbooRoutineScheduleSource({ getDbPath }))
    singleton.register(new OpenClawGatewayCronScheduleSource(getRegistry().source))
  }
  return singleton
}

/** Test-only: drop the singleton so a fresh sandbox can rebuild it. */
export function resetScheduleMultiplexer(): void {
  singleton = null
}
