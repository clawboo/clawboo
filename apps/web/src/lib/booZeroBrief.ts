/**
 * Boo Zero brief generators.
 *
 * One pure function:
 *   - `buildTeamBrief`: per-team markdown brief (stored in SQLite,
 *     surfaced as a virtual file in the UI). No team-chat turn reads it:
 *     the model sees it only in Boo Zero's 1:1 chat, when a message starts
 *     with @TeamName (server/lib/teamChat/teamActivitySummary.ts). In team
 *     chat, the lead's roster carries each teammate's role instead
 *     (server/lib/teamChat/teammateRoles.ts).
 *
 * There is no global brief generator any more: the Global Brief it filled was
 * saved but never read into a prompt. Boo Zero's standing rules are the
 * hard-coded block in `lib/booZeroRules.ts`; guidance for one team goes in
 * that team's rules.
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

/** Escape a value so it reads as one markdown table cell.
 *
 *  Line breaks collapse to spaces first: a row is one line by definition, so a
 *  name or strength carrying a newline would end the row early and let the rest
 *  of the value start fresh markdown structure below the table.
 *
 *  Backslashes are escaped before pipes: escaping only the pipe turns a
 *  member-supplied `\|` into `\\|`, which renders as a literal backslash
 *  followed by a LIVE column separator, splitting the row the escaping was
 *  there to hold together. */
function escapeCell(value: string): string {
  return value
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
}

function renderMembersTable(members: readonly TeamBriefMember[]): string {
  if (members.length === 0) {
    return '_No members yet. Boo Zero will respond solo until the team is populated._'
  }
  const header = '| Name | Role | Strengths | Tools |\n|---|---|---|---|'
  const rows = members.map((m) => {
    const strengths = escapeCell(m.strengths ?? '')
    const tools = escapeCell((m.tools ?? []).join(', '))
    return `| ${escapeCell(m.name)} | ${escapeCell(m.role)} | ${strengths} | ${tools} |`
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
