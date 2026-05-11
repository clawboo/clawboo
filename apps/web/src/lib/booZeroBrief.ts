/**
 * Boo Zero brief generators.
 *
 * Two pure functions:
 *   - `buildTeamBrief`: per-team markdown brief (stored in SQLite,
 *     surfaced as a virtual file in the UI, injected into Boo Zero's
 *     context preamble when it operates on a team's session).
 *   - `buildGlobalBrief`: Boo Zero's overall responsibilities + an
 *     auto-generated index of the teams it leads.
 *
 * Pure. No DB / Gateway / store access. Tests assert markdown shape via
 * snapshots so any future change is visible in a code review.
 */

// ─── Per-team brief ──────────────────────────────────────────────────────────

export interface TeamBriefMember {
  name: string
  role: string
  /** Short one-line strength / specialty (optional). */
  strengths?: string
  /** Skill / tool names this member owns (optional). */
  tools?: string[]
}

export interface TeamBriefInternalLead {
  agentName: string
  /** The leadership keyword that triggered the detection. */
  matchedKeyword: string
}

export interface BuildTeamBriefParams {
  team: {
    name: string
    icon: string
    templateId: string | null
    description?: string | null
  }
  members: TeamBriefMember[]
  internalLead?: TeamBriefInternalLead | null
  /**
   * Optional narrative override for the "Routing patterns" section.
   * When omitted, a default narrative is generated from `members` and
   * `internalLead`.
   */
  routingSummary?: string
  /**
   * Optional list of team-specific anti-patterns / guardrails. When
   * omitted, the standard Clawboo guardrails are included.
   */
  antiPatterns?: string[]
}

const DEFAULT_ANTI_PATTERNS: readonly string[] = [
  "Don't ask the team to simulate sub-agents — workspaces are isolated.",
  "Don't `ls` or `cat` a teammate's directory — you don't have access.",
  'Only delegate via `<delegate to="@AgentName">` blocks; bare @-mentions in prose are best-effort fallbacks.',
]

function renderMembersTable(members: readonly TeamBriefMember[]): string {
  if (members.length === 0) {
    return '_No members yet. Boo Zero will respond solo until the team is populated._'
  }
  const header = '| Name | Role | Strengths | Tools |\n|---|---|---|---|'
  const rows = members.map((m) => {
    const strengths = (m.strengths ?? '').replace(/\|/g, '\\|')
    const tools = (m.tools ?? []).join(', ').replace(/\|/g, '\\|')
    return `| ${m.name} | ${m.role} | ${strengths} | ${tools} |`
  })
  return [header, ...rows].join('\n')
}

function renderInternalLead(lead: TeamBriefInternalLead | null | undefined): string {
  if (!lead) return 'No internal lead detected. Boo Zero leads the team directly.'
  return `**${lead.agentName}** — detected via the leadership keyword "${lead.matchedKeyword}". Boo Zero coordinates through this teammate when strategic decisions or cross-member synthesis are required.`
}

function renderRoutingPatterns(
  members: readonly TeamBriefMember[],
  lead: TeamBriefInternalLead | null | undefined,
  override?: string,
): string {
  if (override && override.trim().length > 0) return override.trim()

  if (members.length === 0) return '- (Team has no members yet.)'

  const lines: string[] = []
  if (lead) {
    lines.push(`- **${lead.agentName}** (internal lead) coordinates intake from Boo Zero.`)
    for (const m of members) {
      if (m.name === lead.agentName) continue
      lines.push(`- **${m.name}** (${m.role}) reports through ${lead.agentName}.`)
    }
  } else {
    lines.push('- Boo Zero delegates directly to each member based on the task.')
    for (const m of members) {
      lines.push(`- **${m.name}** owns: ${m.role}.`)
    }
  }
  return lines.join('\n')
}

function renderAggregatedTools(members: readonly TeamBriefMember[]): string {
  const dedup = new Set<string>()
  for (const m of members) {
    for (const t of m.tools ?? []) dedup.add(t)
  }
  if (dedup.size === 0) return '_No tools recorded yet._'
  return [...dedup]
    .sort()
    .map((t) => `- ${t}`)
    .join('\n')
}

export function buildTeamBrief(params: BuildTeamBriefParams): string {
  const { team, members, internalLead, routingSummary, antiPatterns } = params
  const guardrails = antiPatterns ?? DEFAULT_ANTI_PATTERNS

  const descriptionLine = team.description?.trim()
    ? team.description.trim()
    : team.templateId
      ? `Deployed from template \`${team.templateId}\`.`
      : 'No description recorded.'

  return `# Team: ${team.name} ${team.icon}

## Identity
${descriptionLine}

## Members
${renderMembersTable(members)}

## Internal Lead
${renderInternalLead(internalLead ?? null)}

## Routing patterns
${renderRoutingPatterns(members, internalLead ?? null, routingSummary)}

## Aggregated tools
${renderAggregatedTools(members)}

## Anti-patterns
${guardrails.map((g) => `- ${g}`).join('\n')}

## Notes
_(User-editable. Boo Zero reads this section each time it enters this team.)_
`
}

// ─── Global Boo Zero brief ───────────────────────────────────────────────────

export interface GlobalBriefTeam {
  name: string
  icon: string
  description?: string | null
}

export interface BuildGlobalBriefParams {
  teams: readonly GlobalBriefTeam[]
}

function renderAvailableTeams(teams: readonly GlobalBriefTeam[]): string {
  if (teams.length === 0) {
    return '_No teams deployed yet. When you deploy a team, an entry will appear here automatically._'
  }
  return teams
    .map((t) => {
      const desc = t.description?.trim()
        ? t.description.trim().replace(/\n+/g, ' ')
        : 'No description.'
      return `- **${t.name}** ${t.icon}: ${desc}`
    })
    .join('\n')
}

export function buildGlobalBrief(params: BuildGlobalBriefParams): string {
  const { teams } = params
  return `# Boo Zero — Universal Team Leader

## Role
I am the universal leader across all teams on this Clawboo instance. I do not belong to any team. I sit above team-internal leads when present and coordinate cross-team work for the user.

## Responsibilities
1. Receive user messages in any team's group chat or my individual chat.
2. Decompose tasks into delegations using \`<delegate to="@AgentName">\` inside team chats.
3. Surface progress, blockers, and synthesis back to the user.
4. Maintain per-team context from the team briefs.

## Available teams
${renderAvailableTeams(teams)}

## Delegation protocol
When a teammate should pick up a task, emit a structured delegation block in this exact format:

\`\`\`
<delegate to="@Teammate Name">
A specific, self-contained task description. Include enough context that the
teammate can act without coming back to ask questions.
</delegate>
\`\`\`

You can include multiple \`<delegate>\` blocks in a single response — one per
teammate you're coordinating with. Bare \`@\`-mentions in prose are a best-
effort fallback only.

## @-mention syntax in my individual chat
- \`@TeamName\` → I pull that team's brief into context for this turn so I can
  reason about that specific team.
- \`@AgentName\` → routes to that agent (works in team chats too).

## Common pitfalls
- Don't pretend to know what a team has done — read their group chat first.
- Don't delegate without giving the recipient enough self-contained context.
- Don't try to read a teammate's workspace files — their workspaces are isolated.
- Don't re-respond to \`[Team Update]\` messages as if they were fresh user input.

## Notes
_(User-editable. Use this section for any global instructions you want Boo Zero to always have in context.)_
`
}
