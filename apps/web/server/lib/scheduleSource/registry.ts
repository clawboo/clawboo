// The unified-scheduler singleton: ONE multiplexer over three sources.
// (1) ClawbooRoutineScheduleSource: team-task cron (the Routines ledger) for
//     every runtime class. domain:'team-task', managed.
// (2) OpenClawGatewayCronScheduleSource: the OpenClaw agent's own-life cron
//     via the operator WS-RPC. domain:'runtime-own-life', external-write.
// (3) HermesGatewayJobsScheduleSource: each Hermes agent's own jobs in the
//     Hermes gateway Clawboo supervises (`/p/<profile>/api/jobs`).
//     domain:'runtime-own-life', external-write.
// Team work is always a Clawboo Routine: both runtime sources refuse a
// team-task create. Claude Code, Codex and Clawboo Native have no scheduler of
// their own, so scheduling them is a Routine.

import { ScheduleMultiplexer } from '@clawboo/scheduler'

import { getRegistry } from '../agentSource'
import { getDb } from '../db'
import { ClawbooRoutineScheduleSource } from './clawbooRoutineScheduleSource'
import { hermesJobsBackend } from '../runtimes/hermes'
import { HermesGatewayJobsScheduleSource } from './hermesGatewayJobsScheduleSource'
import { OpenClawGatewayCronScheduleSource } from './openClawGatewayCronScheduleSource'

let singleton: ScheduleMultiplexer | null = null

export function getScheduleMultiplexer(): ScheduleMultiplexer {
  if (!singleton) {
    singleton = new ScheduleMultiplexer()
    singleton.register(new ClawbooRoutineScheduleSource({ getDb }))
    singleton.register(new OpenClawGatewayCronScheduleSource(getRegistry().source))
    singleton.register(new HermesGatewayJobsScheduleSource(hermesJobsBackend()))
  }
  return singleton
}

/** Test-only: drop the singleton so a fresh sandbox can rebuild it. */
export function resetScheduleMultiplexer(): void {
  singleton = null
}
