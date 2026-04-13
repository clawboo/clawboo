// Context relay — forwards condensed agent responses to relevant teammates.
// Pure functions for message formatting, target resolution, and relay guards.
// In-memory state tracks per-team cooldowns and chain depth to prevent loops.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelayConfig {
  maxSummaryChars: number
  maxRelayDepth: number
  relayCooldownMs: number
  enabled: boolean
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  maxSummaryChars: 500,
  maxRelayDepth: 3,
  relayCooldownMs: 10_000,
  enabled: true,
}

// ─── Pure functions ──────────────────────────────────────────────────────────

export function condenseSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  // Try sentence boundary (last period or newline before maxChars)
  const slice = text.slice(0, maxChars)
  const lastPeriod = slice.lastIndexOf('.')
  const lastNewline = slice.lastIndexOf('\n')
  const sentenceBound = Math.max(lastPeriod, lastNewline)
  if (sentenceBound > 0) {
    return text.slice(0, sentenceBound).trimEnd() + '...'
  }

  // Try word boundary (last space before maxChars)
  const lastSpace = slice.lastIndexOf(' ')
  if (lastSpace > 0) {
    return text.slice(0, lastSpace).trimEnd() + '...'
  }

  // Hard truncate
  return slice + '...'
}

export function buildRelayMessage(params: {
  fromAgentName: string
  responseText: string
  taskContext?: string
  maxChars: number
}): string {
  const { fromAgentName, responseText, taskContext, maxChars } = params
  const condensed = condenseSummary(responseText, maxChars)

  let header = `[Team Update] @${fromAgentName} completed their work:`
  if (taskContext) {
    const ctx = taskContext.length > 80 ? taskContext.slice(0, 80) + '...' : taskContext
    header += `\n(re: "${ctx}")`
  }

  return `${header}\n---\n${condensed}\n---\nContinue coordinating based on this update. Tag teammates with @name if further delegation is needed.`
}

export function determineRelayTargets(params: {
  respondingAgentId: string
  teamAgents: Array<{ id: string; name: string }>
  leaderAgentId: string | null
  delegationSourceId?: string
  mentionedAgentIds?: string[]
}): string[] {
  const { respondingAgentId, leaderAgentId, delegationSourceId, mentionedAgentIds } = params
  const targets = new Set<string>()

  if (delegationSourceId && delegationSourceId !== respondingAgentId) {
    targets.add(delegationSourceId)
  }
  if (leaderAgentId && leaderAgentId !== respondingAgentId) {
    targets.add(leaderAgentId)
  }
  if (mentionedAgentIds) {
    for (const id of mentionedAgentIds) {
      if (id !== respondingAgentId) {
        targets.add(id)
      }
    }
  }

  return [...targets].sort()
}

export function shouldRelay(params: {
  responseText: string
  config: RelayConfig
  relayDepth: number
  lastRelayAt?: number
  now?: number
}): boolean {
  const { responseText, config, relayDepth, lastRelayAt, now = Date.now() } = params

  if (!config.enabled) return false
  if (responseText.startsWith('[Team Update]')) return false
  if (relayDepth >= config.maxRelayDepth) return false
  if (lastRelayAt !== undefined && now - lastRelayAt < config.relayCooldownMs) return false
  if (responseText.length < 20) return false

  return true
}

// ─── Stateful relay tracking ─────────────────────────────────────────────────

interface TeamRelayState {
  lastRelayAt: Map<string, number>
  chainDepth: Map<string, number>
}

const relayState = new Map<string, TeamRelayState>()

export function getOrCreateTeamRelayState(teamId: string): TeamRelayState {
  let state = relayState.get(teamId)
  if (!state) {
    state = { lastRelayAt: new Map(), chainDepth: new Map() }
    relayState.set(teamId, state)
  }
  return state
}

export function recordRelay(teamId: string, agentId: string, now?: number): void {
  const state = getOrCreateTeamRelayState(teamId)
  state.lastRelayAt.set(agentId, now ?? Date.now())
}

export function getRelayDepth(teamId: string, chainId: string): number {
  const state = relayState.get(teamId)
  return state?.chainDepth.get(chainId) ?? 0
}

export function incrementRelayDepth(teamId: string, chainId: string): void {
  const state = getOrCreateTeamRelayState(teamId)
  const current = state.chainDepth.get(chainId) ?? 0
  state.chainDepth.set(chainId, current + 1)
}

export function clearTeamRelayState(teamId: string): void {
  relayState.delete(teamId)
}

export function resetAllRelayState(): void {
  relayState.clear()
}
