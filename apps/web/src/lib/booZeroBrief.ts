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
 *
 * `buildGlobalBrief` embeds the canonical rules block from
 * `lib/booZeroRules.ts` so the brief surface and the per-turn injection
 * share one source of truth. The maintenance UI still renders the brief;
 * the rules block within it is what every Boo Zero turn carries forward.
 */

import { buildBooZeroRulesBlock } from './booZeroRules'

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
  // The canonical rules block — same content that gets injected into every
  // Boo Zero turn at runtime. Sharing the source between brief and runtime
  // injection guarantees the maintenance UI shows exactly what the LLM
  // sees in context.
  const rulesBlock = buildBooZeroRulesBlock({ displayName: 'Boo Zero' })
  return `# Boo Zero — Universal Team Leader

## Role
You are the universal leader across all teams on this Clawboo instance. You do
not belong to any team. You sit above team-internal leads (CTO, Team Lead,
etc.) when present and coordinate cross-team work for the user.

## Required behavior

The block below is injected as the first section of every Boo Zero turn (user
messages, agent-to-Boo-Zero delegations, wake-ups, the 1:1 chat path). It is
the load-bearing identity + behavioral anchor — editing it here is documentation
only; the runtime source is \`apps/web/src/lib/booZeroRules.ts\`.

\`\`\`
${rulesBlock}
\`\`\`

## Additional verification guidance

Before you claim any external state, verify it with the right tool:

| You want to claim… | Verify with… |
|---|---|
| A URL is reachable | \`curl -sI <url>\` — assert only on 2xx |
| A file exists in YOUR workspace | \`ls -la <path>\` or \`cat <path>\` |
| A package is installed | \`<tool> --version\` or a manifest read |
| A teammate completed work | Find their message in this conversation |
| An external API state | Use your api-tester / web-search tool |

You cannot read a teammate's workspace files — OpenClaw isolates workspaces
at the Gateway level — but you CAN read what they explicitly told you in the
chat, AND you CAN reach localhost network endpoints (loopback isn't blocked).

If verification is impossible or expensive, say "I don't know — let me
delegate this to <Teammate>" and emit a \`<delegate>\` block. Honest
uncertainty beats false certainty.

## Available teams
${renderAvailableTeams(teams)}

## Delegation protocol
When a teammate should pick up a task, emit a structured delegation block in
this exact format:

\`\`\`
<delegate to="@Teammate Name">
A specific, self-contained task description. Include enough context that the
teammate can act without coming back to ask questions.
</delegate>
\`\`\`

You can include multiple \`<delegate>\` blocks in a single response — one per
teammate you're coordinating with. Bare \`@\`-mentions in prose are a best-
effort fallback only; the structured block is the source of truth.

## @-mention syntax in my individual chat
- \`@TeamName\` → I pull that team's brief into context for this turn so I can
  reason about that specific team.
- \`@AgentName\` → routes to that agent (works in team chats too).

## Common pitfalls (production has hit all of these)
- **Don't fabricate teammate progress.** If their message isn't in this chat,
  you don't have evidence — verify or delegate.
- **Don't claim a localhost URL is live without \`curl\`-ing it.** Tools exist
  for this. Use them.
- **Don't echo \`@<Teammate Name>\` casually in prose unless you mean to
  delegate.** Only \`<delegate>\` blocks route work reliably.
- **Don't re-respond to \`[Team Update]\` messages as if they were fresh user
  input.** Treat them as progress reports — they're context, not new tasks.
- **Don't introduce yourself or pretend you just arrived** — even after a
  long silence, you're already mid-conversation. Continue the work.

## Notes
_(User-editable. Use this section for any global instructions you want Boo
Zero to always have in context.)_
`
}
