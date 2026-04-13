export type TeammateDef = { name: string; role: string }

export type BuildTeamAgentsMdParams = {
  agentName: string
  teamName: string
  teammates: TeammateDef[]
  routingRules: string
}

export type BuildTeamWakeMessageParams = {
  agentName: string
  teamName: string
  teammates: TeammateDef[]
}

export type TeamContextEntry = {
  agentName: string
  text: string
  timestampMs: number
  kind: string
  role: string
}

export type BuildTeamContextPreambleParams = {
  entries: TeamContextEntry[]
  targetAgentName: string
  maxMessages?: number
  maxChars?: number
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function buildTeamAgentsMd(params: BuildTeamAgentsMdParams): string {
  const { agentName, teamName, teammates, routingRules } = params
  const rules = routingRules.trim() || 'No specific routing rules defined.'

  if (teammates.length === 0) {
    return `# AGENTS\n\n### Routing Rules\n${rules}\n`
  }

  const rows = teammates.map((t) => `| @${t.name} | ${t.role} |`).join('\n')

  return `# AGENTS — Team Collaboration

## Your Team: ${teamName}
You are **${agentName}** — a member of a multi-agent team on this OpenClaw Gateway.

### Teammates
| Name | Role |
|------|------|
${rows}

### CRITICAL: Real Agents, Not Sub-Agents
Your teammates listed above are REAL OpenClaw agents running on this Gateway, each with their own sessions and context windows. They are NOT sub-agents or simulations.

**DO NOT:**
- Spawn sub-agents, sub-tasks, or worker agents to simulate teammates
- Create new agents with teammate names
- Role-play as your teammates or make up their responses

### Collaboration Protocol
When you need a teammate's help, clearly tag them in your response:
  "@${teammates[0]!.name}, please investigate the null pointer in auth.ts:42"

The orchestration system will:
1. Route your request to the tagged teammate
2. Relay their response back to you as a [Team Update] message
3. You then continue with that context

**Do NOT wait or poll for responses** — they will arrive automatically.

### Routing Rules
${rules}
`
}

export function buildTeamWakeMessage(params: BuildTeamWakeMessageParams): string {
  const { agentName, teamName, teammates } = params
  const list = teammates.map((t) => `- @${t.name} (${t.role})`).join('\n')

  return `You are joining a team collaboration session as ${agentName}.

Team: ${teamName}
Your teammates:
${list}

These are REAL agents with their own sessions on this Gateway. Do NOT spawn sub-agents to simulate them.
When you need help from a teammate, tag them with @name in your response — the orchestration system handles routing.
You will receive [Team Update] messages when teammates complete work relevant to you.

Please briefly introduce yourself — your name and what you specialize in, in one sentence.`
}

export function buildTeamContextPreamble(params: BuildTeamContextPreambleParams): string | null {
  const { entries, targetAgentName, maxMessages = 8, maxChars = 1200 } = params

  const relevant = entries.filter((e) => {
    if (e.agentName === targetAgentName) return false
    if (e.kind === 'meta') return false
    if (e.text.startsWith('[Team Update]')) return false
    return true
  })

  if (relevant.length === 0) return null

  const last = relevant.slice(-maxMessages)

  const lines: string[] = []
  for (const e of last) {
    const name = e.role === 'user' ? 'User' : e.agentName
    const text = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text
    lines.push(`[${formatTime(e.timestampMs)}] ${name}: ${text}`)
  }

  // Drop oldest lines until total fits within maxChars
  while (lines.length > 0) {
    const body = lines.join('\n')
    const full = `[Team Context — last ${lines.length} messages]\n${body}\n[End Team Context]`
    if (full.length <= maxChars) return full
    lines.shift()
  }

  return null
}
