// Whether a team's orchestration runs SERVER-side. After the OpenClaw cutover EVERY
// team is server-orchestrated — native, OpenClaw, and mixed all run on the ONE server
// engine (`teamOrchestrator` → `serverDeliver` → `createBoardOrchestrator`); the browser
// team-orchestration path is retired. The result is TRUE unless a team explicitly opts
// out via `team-server-orchestrated:<teamId>='false'` — a defensive escape hatch nothing
// sets today (kept so a future coexistence mode could re-introduce a browser path).
//
// This is also the DOUBLE-ORCHESTRATION FIREWALL seam: the chat ingest / stop routes
// gate on it. With the browser engine gone there is no second driver to guard against,
// so the default is ON.

import { getSetting, type ClawbooDb } from '@clawboo/db'

export function serverOrchestratedSettingKey(teamId: string): string {
  return `team-server-orchestrated:${teamId}`
}

export function resolveServerOrchestrated(db: ClawbooDb, teamId: string): boolean {
  return getSetting(db, serverOrchestratedSettingKey(teamId)) !== 'false'
}
