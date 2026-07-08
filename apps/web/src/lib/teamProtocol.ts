// The broken-shape assistant-turn filter + its control-token constants moved to
// @clawboo/team-orchestration (shared with the server-side single chat writer so a
// thin client that skips the render filter still never persists a control token).
// Imported for local use AND re-exported at the bottom so existing
// `@/lib/teamProtocol` consumers (chatComponents, teamProtocol.test.ts) keep
// working unchanged.
import {
  RESUME_ACK_TOKEN,
  SKIP_ACK_TOKEN,
  MIN_SUBSTANTIVE_LENGTH,
  isOpenclawControlToken,
  isClawbooControlToken,
  isLikelyRefusal,
  shouldDropAssistantTurn,
} from '@clawboo/team-orchestration'

export type TeammateDef = { name: string; role: string }

export type BuildTeamAgentsMdParams = {
  agentName: string
  teamName: string
  teammates: TeammateDef[]
  routingRules: string
  /**
   * Name of the universal team leader (Boo Zero). When provided, the
   * generated AGENTS.md adds a "Universal Leader" section telling the
   * agent it can route upward via `<delegate to="@Boo Zero">` for
   * higher-level coordination, synthesis, or cross-team requests.
   */
  universalLeaderName?: string | null
  /**
   * Optional name of the team-internal lead (CTO, Team Lead, etc.,
   * detected via `detectGenuineLeader`). When set AND distinct from
   * `agentName`, the AGENTS.md surfaces it as the team's coordinator
   * under the universal leader.
   */
  teamInternalLeadName?: string | null
}

export type BuildClawbooHelpDocParams = {
  agentName: string
  teamName: string
  /** Teammates excluding self. Roles are optional — only `name` is used for paths. */
  teammates: TeammateDef[]
  /** Optional Boo Zero name for the universal-leader note. */
  universalLeaderName?: string | null
}

/**
 * Slugify an agent name into the directory leaf used by `createAgent`.
 * MUST stay in sync with `slugifyName` in `lib/createAgent.ts:29` — the
 * resulting workspace path is `<stateDir>/workspace-<slug>` on disk, and
 * we expose those paths to agents in `CLAWBOO.md` so they know exactly
 * where their teammates' workspaces live.
 */
export function slugifyAgentName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
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
  /**
   * Optional user self-introduction — captured during the team onboarding
   * gate. When present, it's emitted as a dedicated `[About the User]` block
   * BEFORE the conversation history so the agent always knows who they're
   * talking to. This is the primary delivery mechanism for the user intro
   * because Gateway `agents.files.set('SOUL.md')` is unreliable for
   * persistence in older runtimes.
   */
  userIntroText?: string
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function buildTeamAgentsMd(params: BuildTeamAgentsMdParams): string {
  const {
    agentName,
    teamName,
    teammates,
    routingRules,
    universalLeaderName,
    teamInternalLeadName,
  } = params
  const rules = routingRules.trim() || 'No specific routing rules defined.'

  // Universal leader section — Boo Zero is the leader of every team. We
  // mention it whether or not the agent has explicit routing rules to it,
  // so any team agent can escalate / delegate "upward" via `<delegate>`.
  const universalLeaderBlock = universalLeaderName
    ? `### Universal Leader: @${universalLeaderName}
**${universalLeaderName}** is the universal team leader on this Clawboo instance — sitting above every team, including yours. You can address it explicitly with \`@${universalLeaderName}\` in your responses, and route higher-level coordination, synthesis, or cross-team requests via:

\`\`\`
<delegate to="@${universalLeaderName}">
A specific request — strategic decision, cross-team synthesis, blocker the team
can't resolve alone, etc.
</delegate>
\`\`\`

${
  teamInternalLeadName && teamInternalLeadName !== agentName
    ? `Within team **${teamName}**, **${teamInternalLeadName}** is the team-internal lead under ${universalLeaderName}. They coordinate intake from ${universalLeaderName} and own internal team flow.\n`
    : ''
}
`
    : ''

  if (teammates.length === 0) {
    return `# AGENTS

## Your Team: ${teamName}
You are **${agentName}**.

${universalLeaderBlock}### Routing Rules
${rules}
`
  }

  const rows = teammates.map((t) => `| @${t.name} | ${t.role} |`).join('\n')
  const exampleTeammate = teammates[0]!.name

  return `# AGENTS — Team Collaboration

## Your Team: ${teamName}
You are **${agentName}** — a member of a multi-agent team on this OpenClaw Gateway.

${universalLeaderBlock}### Teammates
| Name | Role |
|------|------|
${rows}

### CRITICAL: Real Agents, Not Sub-Agents
Your teammates listed above are REAL OpenClaw agents running on this Gateway, each with their own sessions and context windows. They are NOT sub-agents or simulations.

**DO NOT:**
- Spawn sub-agents, sub-tasks, or worker agents to simulate teammates
- Create new agents with teammate names
- Role-play as your teammates or make up their responses

### Workspace Isolation
Each teammate has their **own isolated workspace** on disk. You CANNOT
read their files — \`ls\` and \`cat\` on a teammate's directory will fail
or be empty. If you need to know what a teammate has built, do NOT try
to inspect their files; instead, delegate a status request:

\`\`\`
<delegate to="@${exampleTeammate}">
Send me a summary of what you've built so far + the key file paths in
your workspace.
</delegate>
\`\`\`

### Detailed Reference
The full Clawboo operating reference lives at \`~/CLAWBOO.md\` in your
workspace. Run \`cat ~/CLAWBOO.md\` whenever you're unsure how the team
works — it covers \`[Team Update]\` message semantics, workspace paths
for every teammate, the orchestration loop, and common pitfalls.

### Delegation Protocol (REQUIRED)

When you want a teammate to take on a task, emit a delegation block in this **exact** format:

\`\`\`
<delegate to="@Teammate Name">
A specific, self-contained task description. Include enough context that the
teammate can act without coming back to ask questions.
</delegate>
\`\`\`

You can include multiple \`<delegate>\` blocks in a single response — one per
teammate you're coordinating with.

**Example response that delegates work:**

\`\`\`
Here's the plan for this sprint.

<delegate to="@${exampleTeammate}">
Investigate the null pointer in auth.ts:42 — check whether JWT signing handles
a null \`kid\` header gracefully. Report back what you find.
</delegate>
\`\`\`

**DO**
- Write conversational text for the user, then emit one or more \`<delegate>\`
  blocks for the teammates who should pick up work.
- Make each task self-contained with all the context the teammate needs.

**DO NOT**
- Rely on plain @-mentions in prose ("@${exampleTeammate}, please…",
  "@${exampleTeammate} — handle X", "Time: @${exampleTeammate} builds Y") for
  delegation. The orchestration system gives the structured \`<delegate>\` block
  the highest confidence; prose forms are only a fallback and may not route.
- Wait for or poll teammates' responses; their replies arrive automatically as
  \`[Team Update]\` messages, after which you continue with that context.
- **Take initiative on work that wasn't delegated to YOU.** Only act on
  \`<delegate to="@${agentName}">\` blocks aimed at you specifically.
  \`[Team Update]\` messages and other teammates' work are read-only context,
  not action items. If you think you could help on something a teammate is
  doing (e.g., you spotted a UX issue in their code), propose it via a
  \`<delegate to="@<that teammate>">\` block — don't just start doing it
  yourself in parallel. Production has shown that uncoordinated parallel
  work produces duplicate / conflicting outputs.

### Resuming sessions

OpenClaw sessions go cold when idle. Before sending you a real task, the
orchestrator sends a structured warm-up message that looks like this:

> "[RESUME_SIGNAL — this is NOT a user message]
> Your session is being reactivated as ${agentName} on team "${teamName}".
> This message is a warm-up ping, not work for you.
>
> REQUIRED RESPONSE: Reply with EXACTLY the single token \`__resumed__\` and
> nothing else. No greeting. No introduction. No emoji. No acknowledgement
> beyond that one word.
>
> The next message you receive will be the actual instruction. Pick up the
> work then."

**This is a session-warmup signal, not work for you to do.**

When you see it:
- Reply with EXACTLY \`__resumed__\` (no other text, no whitespace, no
  punctuation).
- Do NOT introduce yourself.
- Do NOT greet teammates ("Welcome aboard!", "Hey Frontend Boo!", etc.).
- Do NOT acknowledge the re-init in any other way.

Your prior context — this AGENTS.md, your SOUL.md, your TOOLS.md, the team
brief — is still loaded. The next message you receive (a \`[Team Update]\`
from a teammate, or a fresh user message) is where you engage. Pick up the
work as if there was no pause.

### When you have nothing substantive to add

If a \`[Team Update]\` or delegation arrives and you genuinely have nothing
to contribute (the work is outside your specialty, you'd just be repeating
a teammate's point, etc.), emit ONLY the literal token \`__skipped__\` and
nothing else. The renderer filters it out — the chat stays clean and the
orchestrator knows you've acknowledged.

OpenClaw protocol tokens (\`ANNOUNCE_SKIP\`, \`NO_REPLY\`) are also filtered
by the renderer as a safety net, but prefer \`__skipped__\` as the canonical
Clawboo signal.

DO NOT emit:
- A bare \`NO\` or \`NOPE\` — these get filtered as broken-shape leaks, and
  you should not emit them in the first place. If you disagree with
  something, explain why in a full sentence (≥25 chars).
- An acknowledgment ("OK", "Got it", "Will do") with no other content. If
  you have nothing else to add, use \`__skipped__\` instead.
- Variations like \`SKIP\`, \`PASS\`, \`NO_RESPONSE\`, or invented control
  tokens. Stick to the canonical \`__skipped__\`.

### Receiving [Team Update] messages

A \`[Team Update]\` message looks like this:

> [Team Update] — relayed summary from @<Name> (not a fresh user message)
> The teammate finished a delegated task. Continue your own work using this update as context.
> ---
> ...summary body...
> ---

**This is a progress report, NOT a fresh user message.** Do NOT respond to
it as if the user just spoke. Record it silently as context for your own
work. Only emit a new response if you have substantive new work to do based
on this update — and even then, the response should be that NEW work, not
an acknowledgment.

DO NOT emit:
- "Got it — that's the X layer"
- "Done! Created Y"
- "Quiz created — N questions covering ..."
- "Ready for the next deliverable"
- Any text that just narrates what the teammate did

If you have nothing substantive to add, emit ONLY \`__skipped__\` and
nothing else.

### After producing a deliverable

When you produce a deliverable (a file write, a code block, a JSON object,
a table, a structured response), the deliverable IS the response. Do NOT
emit a separate acknowledgment turn ("Done!", "Quiz created — 5 questions
covering X, Y, Z. Ready for next.") after the actual content.
Acknowledgment-only turns are pure noise — the user can already see your
deliverable above. If a follow-up is genuinely warranted (e.g., a question
back to the orchestrator), make sure it has substantive content; do not
narrate completion.

### Routing Rules
${rules}
`
}

export function buildTeamContextPreamble(params: BuildTeamContextPreambleParams): string | null {
  const { entries, targetAgentName, maxMessages = 8, maxChars = 1200, userIntroText } = params

  const relevant = entries.filter((e) => {
    if (e.agentName === targetAgentName) return false
    if (e.kind === 'meta') return false
    if (e.text.startsWith('[Team Update]')) return false
    return true
  })

  // Build the optional user-intro block. We always emit it (when provided)
  // so the agent sees the user's self-introduction on every message, even
  // on the very first message when there's no conversation history yet.
  const introTrimmed = (userIntroText ?? '').trim()
  const userBlock = introTrimmed ? `[About the User]\n${introTrimmed}\n[End About the User]` : null

  if (relevant.length === 0) {
    // No conversation history — return just the user intro block, or null
    // if neither is available.
    return userBlock
  }

  const last = relevant.slice(-maxMessages)

  const lines: string[] = []
  for (const e of last) {
    const name = e.role === 'user' ? 'User' : e.agentName
    const text = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text
    lines.push(`[${formatTime(e.timestampMs)}] ${name}: ${text}`)
  }

  // Drop oldest lines until total fits within maxChars (budget includes
  // the user intro block when present so the agent always sees it).
  const introBudget = userBlock ? userBlock.length + 2 /* \n\n */ : 0
  while (lines.length > 0) {
    const body = lines.join('\n')
    const ctx = `[Team Context — last ${lines.length} messages]\n${body}\n[End Team Context]`
    if (ctx.length + introBudget <= maxChars) {
      return userBlock ? `${userBlock}\n\n${ctx}` : ctx
    }
    lines.shift()
  }

  // History didn't fit even with 0 entries — fall back to just the user block.
  return userBlock
}

// ─── CLAWBOO.md — workspace-resident operating reference ────────────────────

/**
 * Generate the `CLAWBOO.md` doc that sits at the agent's workspace root.
 * Agents `cat ~/CLAWBOO.md` whenever they need to look something up — this
 * keeps frequent essentials in `AGENTS.md` (always loaded into context) and
 * detailed reference here (zero per-message token cost). The pattern mirrors
 * how Devin and Anthropic Computer Use treat the workspace as documentation.
 *
 * Includes every teammate's actual workspace path so agents know exactly
 * where (not) to look. Paths are derived from `slugifyAgentName` to match
 * `createAgent` exactly.
 */
export function buildClawbooHelpDoc(params: BuildClawbooHelpDocParams): string {
  const { agentName, teamName, teammates, universalLeaderName } = params
  const yourSlug = slugifyAgentName(agentName)
  const teammatePathRows = teammates
    .map((t) => `  ${t.name}'s workspace: ~/.openclaw/workspace-${slugifyAgentName(t.name)}`)
    .join('\n')

  // Use the first teammate as a concrete example so the agent doesn't have
  // to invent a placeholder name. Fall back to a generic name if solo.
  const exampleName = teammates[0]?.name ?? 'Teammate Name'

  const universalLeaderBlock = universalLeaderName
    ? `## Universal Leader: ${universalLeaderName}

**${universalLeaderName}** is Clawboo's universal team leader — it sits above
every team on this instance, including ${teamName}. ${universalLeaderName}
triages user messages, decides what each teammate should pick up, and synthesizes
results back to the user. When you finish a delegated task, your response is
relayed to ${universalLeaderName} automatically; you do not need to ping it.

You CAN escalate upward by emitting:

\`\`\`
<delegate to="@${universalLeaderName}">
A specific request — a strategic decision, a synthesis across teammates, a
blocker your team can't resolve internally, a cross-team handoff.
</delegate>
\`\`\`

Do NOT \`@${universalLeaderName}\` casually in prose — only via \`<delegate>\`
blocks. Bare mentions are a best-effort fallback and may not route.

`
    : ''

  // When THIS agent is the universal leader, its CLAWBOO.md carries the full
  // leadership protocol — the verbose examples + DO/DON'T list that the thin
  // per-turn anchor (booZeroRules) points back to under KV-cache discipline.
  const isUniversalLeader = Boolean(universalLeaderName && agentName === universalLeaderName)
  const leadershipBlock = isUniversalLeader
    ? `## Leadership Protocol (you are the universal leader)

You coordinate; you do not do teammate work yourself. \`<delegate>\` is the ONLY
routing mechanism — never spawn sub-agents or use a built-in task/sub-agent tool.

CORRECT (single delegation with narration):
> I'll have @Geographer Boo handle the climate piece.
> <delegate to="@Geographer Boo">Design a volcanic island setting…</delegate>

CORRECT (multiple in one turn — they run in parallel):
> <delegate to="@Geographer Boo">…</delegate>
> <delegate to="@Historian Boo">…</delegate>

WRONG (none of these route or render a card):
- "Let me delegate:---"  (markdown rule, no tag)
- "@Geographer Boo, please handle it"  (prose-only mention)
- \`<delegate to="@X">task\`  (missing closing tag)
- \`<delegate to=@X>task</delegate>\`  (missing quotes)

### \`<plan>\` blocks — 3+ ordered steps
Emit a \`<plan>\` and Clawboo fires step 1, then auto-advances each step with the
prior output piped in (you don't re-prompt). On \`[Plan Complete]\`, do final synthesis.

\`\`\`
<plan>
  <step to="@Writer Boo">Write the copy first.</step>
  <step to="@Designer Boo">Design from the copy.</step>
</plan>
\`\`\`

### Parallel workstreams — ≥2 \`<delegate>\` in one turn (no \`<plan>\`)
Clawboo tracks them as a batch. Wait silently for individual \`[Team Update]\`s;
synthesize only when you receive the \`[Workstreams Complete]\` envelope.

### DO / DON'T
- DO delegate every non-trivial request via the exact \`<delegate>\` syntax.
- DO verify external state with tools (read, list, etc.) before claiming it.
- DON'T emit acknowledgment-only text ("Got it", "Nice") for \`[Team Update]\`s.
- DON'T claim a teammate "timed out" — say "still waiting on @<name>" and continue.
- DON'T do a teammate's work yourself, even if no one has replied yet.
- DON'T greet or re-introduce yourself on resume — pick up where you left off.
- DON'T write a file a teammate also owns — namespace your filename or let one owner emit it.
- If you have nothing substantive to add, emit ONLY the token \`__skipped__\` (never a bare "NO"/"SKIP").

`
    : ''

  return `# CLAWBOO — Team Operating Reference

You are **${agentName}**, an agent in team **${teamName}** on Clawboo, a
multi-agent dashboard built on OpenClaw. This file is the detailed reference
for how the team works. Read it any time you're unsure — \`cat ~/CLAWBOO.md\`.

${universalLeaderBlock}
${leadershipBlock}
## Workspaces are isolated

Every teammate has their OWN workspace on disk. You CANNOT read their files.

  Your workspace:        ~/.openclaw/workspace-${yourSlug}
${teammatePathRows}

If you need to know what a teammate has built, do NOT \`ls\` or \`cat\`
their directory (you don't have permission, and the files won't be there
from your perspective). Instead, delegate a status request:

\`\`\`
<delegate to="@${exampleName}">
Send me a summary of what you've built so far + the key file paths in
your workspace.
</delegate>
\`\`\`

## Delegation protocol — REQUIRED

When you want a teammate to take on a task, emit:

\`\`\`
<delegate to="@Teammate Name">
A specific, self-contained task description. Include all the context the
teammate needs to act without coming back to ask questions.
</delegate>
\`\`\`

You can include multiple \`<delegate>\` blocks in a single response.

## Messages you'll receive

The user message you're seeing may be wrapped in some structured blocks:

- \`[About the User] ... [End About the User]\`
  — Who you're talking to. Background context. Don't reply to it directly.

- \`[Team Context — last N messages] ... [End Team Context]\`
  — Recent conversation between your teammates and the user. Background
    context. Use it to understand the conversation so far.

- \`[Team Update] — relayed summary from @<Name> ...\`
  — A teammate finished a delegated task. **THIS IS NOT A FRESH USER
    MESSAGE.** Do NOT respond as if the user just spoke. Treat it as a
    progress update and continue your own work using it as context.

## Common pitfalls (production has hit all of these)

- **Don't fabricate teammate work.** If you can't see it, you don't have
  it. Ask via \`<delegate>\` instead of inventing details.
- **Don't \`ls\` or \`cat\` teammate directories.** You don't have access.
  See "Workspaces are isolated" above.
- **Don't simulate teammates by spawning sub-agents.** Your teammates are
  REAL OpenClaw agents on this Gateway with their own contexts.
- **Don't wait silently for teammates.** They reply via \`[Team Update]\`
  messages — those arrive automatically; you don't need to poll.
- **Don't echo \`@teammate\` casually unless you mean to delegate.** Only
  \`<delegate>\` blocks route work; bare \`@\`-mentions in prose are best-
  effort fallbacks and may not route.

## The full orchestration loop

1. User sends a message → it goes to the leader (or the agent the user
   \`@\`-mentioned).
2. The recipient emits \`<delegate>\` blocks for any work that's a
   teammate's responsibility.
3. Each \`<delegate>\` is routed to that teammate's session by Clawboo.
4. When a teammate finishes, their response is condensed and relayed to
   the original delegator (and any other relevant teammate) as a
   \`[Team Update]\` message.
5. The delegator continues with the new context — which may include
   emitting more \`<delegate>\` blocks if more work is needed.
`
}

// ─── Self-documenting [Team Update] envelope ────────────────────────────────
// Moved to @clawboo/team-orchestration (shared with the server orchestrator);
// re-exported here so existing `@/lib/teamProtocol` imports keep working.
export {
  buildTaskUpdateMessage,
  type TaskUpdateItem,
  type TaskUpdateOutcome,
} from '@clawboo/team-orchestration'

// ─── Broken-shape assistant-turn filter ─────────────────────────────────────
// Moved to @clawboo/team-orchestration (shared with the server-side chat writer);
// re-exported so existing `@/lib/teamProtocol` consumers keep working.
export {
  RESUME_ACK_TOKEN,
  SKIP_ACK_TOKEN,
  MIN_SUBSTANTIVE_LENGTH,
  isOpenclawControlToken,
  isClawbooControlToken,
  isLikelyRefusal,
  shouldDropAssistantTurn,
}
