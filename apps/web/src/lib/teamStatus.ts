import type { AgentStatus } from '@clawboo/gateway-client'
import type { AgentState } from '@/stores/fleet'

/**
 * Aggregate the team's overall status from its members. Mirrors the status
 * badge shown on individual agent rows so the Group Chat row reads as a peer
 * in the list. Priority: any running > any error > any sleeping > idle.
 *
 * Phase 17 hoisted this from AgentListColumn so the Atlas team-status
 * clusters can reuse the exact same priority logic.
 */
export function aggregateTeamStatus(teamAgents: AgentState[]): AgentStatus {
  if (teamAgents.length === 0) return 'idle'
  if (teamAgents.some((a) => a.status === 'running')) return 'running'
  if (teamAgents.some((a) => a.status === 'error')) return 'error'
  if (teamAgents.some((a) => a.status === 'sleeping')) return 'sleeping'
  return 'idle'
}

export interface TeamStatusBreakdown {
  idle: number
  running: number
  sleeping: number
  error: number
  total: number
}

/**
 * Count agents per status bucket. Used by the Atlas TeamStatusClusterLayer to
 * render compact `● N` indicators above each team-root junction.
 */
export function teamStatusBreakdown(teamAgents: AgentState[]): TeamStatusBreakdown {
  const breakdown: TeamStatusBreakdown = {
    idle: 0,
    running: 0,
    sleeping: 0,
    error: 0,
    total: teamAgents.length,
  }
  for (const agent of teamAgents) {
    switch (agent.status) {
      case 'running':
        breakdown.running++
        break
      case 'error':
        breakdown.error++
        break
      case 'sleeping':
        breakdown.sleeping++
        break
      default:
        breakdown.idle++
        break
    }
  }
  return breakdown
}
