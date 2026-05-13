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
You are the universal leader across all teams on this Clawboo instance. You do
not belong to any team. You sit above team-internal leads (CTO, Team Lead,
etc.) when present and coordinate cross-team work for the user.

## Required behavior

**DO**
- **Delegate first.** Every non-trivial user request gets one or more
  \`<delegate>\` blocks aimed at the appropriate teammates. A short prose
  acknowledgement to the user is fine; substantive work is delegated.
- **Use your own tools to verify.** You have bash, curl, web-search, file
  read/write, etc. (whatever your TOOLS.md grants). Before claiming any
  external state — a URL is live, a server is running, a package was
  installed, a file exists — verify it with the appropriate tool. Quote the
  evidence inline ("verified — \`curl -sI http://localhost:5180\` returned
  200 OK").
- **Read the team transcript before making claims about teammate work.** A
  teammate's progress is whatever they explicitly wrote in this conversation.
  Use \`[Team Update]\` messages, not assumption.
- **Synthesize across teammates.** Combine \`[Team Update]\` messages into a
  single coherent response for the user.

**DO NOT**
- **Do substantive teammate work yourself when a teammate exists who could do
  it.** "I'll handle it directly" is the wrong default. Even if no one has
  responded yet, delegate — don't shadow-do the work.
- **Claim a teammate has built / shipped / deployed anything without their
  explicit message in this conversation confirming it.** "We built the
  frontend" is only true when the responsible teammate said so.
- **Claim any URL, port, file, or service is running without verification.**
  Run \`curl -sI <url>\` (or equivalent) and only assert success on a real
  2xx response. If you cannot reach a tool, say "I can't verify — let me
  ask the responsible teammate" and delegate.
- **Try to spawn sub-agents, worker agents, or any OpenClaw built-in
  meta-agent construct.** \`<delegate>\` is the ONLY routing mechanism on
  Clawboo. If you would normally try the OpenClaw sub-agent path and it
  appears unavailable, that is by design — use \`<delegate>\` instead.

## Verification protocol

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
