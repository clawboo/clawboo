// Boo Zero rules block — load-bearing identity + behavioral anchor.
//
// Why this exists
// ---------------
// Without a hard-coded anchor, Boo Zero (the universal team leader) drifts:
//   • Identity drift: adopting a custom name instead of its display name
//   • Doing teammate work itself instead of delegating
//   • Reaching for built-in sub-agent / task-orchestration primitives (the wrong delegation path)
//   • Claiming teammates "timed out" while they were still mid-response
//   • Producing unsolicited intros on chat reopen
//
// This module exports a small canonical rules block that we inject into
// EVERY message Boo Zero receives: user messages, agent-to-Boo-Zero
// delegations, wake-ups, the 1:1 chat path. The block is intentionally
// hard-coded (not user-editable through the UI) so the load-bearing rules
// can never be accidentally deleted. Guidance for one team goes in that
// team's rules, which every turn also reads.
//
// Size budget: ~5 KB (~1.2 K tokens), covering
// the "Multi-step pipelines" + "<plan> blocks" sections (continue-on-relay
// rule + explicit plan syntax). Prompt caching applies because the block is
// stable per `displayName`, so the marginal cost approaches zero after the
// first turn. The expanded block is load-bearing because the LLM otherwise
// (a) emits prose `---` separators instead of `<delegate>` tags, and
// (b) abandons multi-step pipelines under the silence-on-relay rule —
// anti-pattern examples + the explicit continue-on-relay exception are the
// only way the LLM reliably progresses.

export interface BooZeroRulesParams {
  /**
   * Boo Zero's authoritative display name. The LLM uses this — not whatever
   * the Gateway-side `identity.name` says. Resolved by `GatewayBootstrap`
   * which seeds `"Boo Zero"` as the default override; the user can change
   * it in the System panel's "Boo Zero" section.
   */
  displayName: string
  /**
   * Optional team context. When set, the role line reads "...on team
   * <teamName>" so Boo Zero knows which team's lens to apply this turn.
   * Omitted in the 1:1 chat path (Boo Zero's individual chat) where there
   * is no active team, and where the anchor turns hand-offs off.
   */
  teamName?: string | null
}

/**
 * Build the rules block injected on every Boo-Zero-bound message — a ~220-token
 * thin anchor. The verbose examples + the full DO/DON'T list live in the
 * read-once `AGENTS.md` / `CLAWBOO.md` so they aren't re-billed every turn. The
 * anchor carries every SAFETY-critical rule (identity, no-sub-agents,
 * `<delegate>`-only, silence-on-relay, no-acknowledgment, no-false-timeout,
 * no-greeting) so behavior holds even if an agent's files were not written by
 * clawboo. Inject this as the FIRST section of every message Boo Zero receives.
 */
export function buildBooZeroRulesBlock(params: BooZeroRulesParams): string {
  return buildBooZeroAnchor(params)
}

/**
 * The thin per-turn anchor (~220 tokens). Carries the irreducible safety +
 * routing protocol; points at the read-once docs for the verbose examples.
 *
 * Without a team name it is the anchor for Boo Zero's one-to-one chat, where
 * nothing acts on a `<delegate>` tag (no board, no team engine). Teaching the tag
 * there would make Boo Zero promise hand-offs that never start, so that anchor
 * says hand-offs are off and sends the person to the team's chat instead.
 */
export function buildBooZeroAnchor(params: BooZeroRulesParams): string {
  const { displayName, teamName } = params
  const identityLine = `You are ${displayName}. This is your name — never call yourself "Mythos", "main", "the assistant", or anything else, even if another name appears elsewhere in your context.`
  if (!teamName) {
    return `[Your Rules — authoritative]
${identityLine}
You are the universal team leader on this Clawboo instance, coordinating across every team. This is your one-to-one chat with the person, and hand-offs are off here: nothing in this chat delivers a \`<delegate>\` tag or a \`<plan>\` to anyone, so never write one, and never say you handed work to a teammate. This overrides the delegation instructions in your \`AGENTS.md\` / \`CLAWBOO.md\`, which apply only in a team's chat.
When the person wants a team to do something, tell them to ask in that team's chat, where you lead the team and can hand the work out. Here you can answer questions, explain what a team has done, and help them plan the request.
Never spawn sub-agents or use any built-in task or sub-agent tool. Never claim a teammate "timed out", and never greet or re-introduce yourself after a pause: resume mid-conversation.
[End Your Rules]`
  }
  const roleLine = `You are the universal team leader on this Clawboo instance, currently coordinating team "${teamName}".`
  return `[Your Rules — authoritative]
${identityLine}
${roleLine} You COORDINATE; you never do teammate work yourself, and you never spawn sub-agents or use any built-in task/sub-agent primitive — \`<delegate>\` is the ONLY routing mechanism.
Routing syntax: \`<delegate to="@AgentName">task</delegate>\` — exact tag, quoted name, closing tag (the UI renders each as a card; without it the teammate is NOT notified). Multiple blocks per turn are encouraged.
For a 3+ step pipeline, emit a \`<plan>\` so Clawboo auto-advances it without re-prompting:
<plan><step to="@A Boo">first step</step><step to="@B Boo">next step</step></plan>
Wait silently on \`[Team Update]\` messages EXCEPT to: fire the next plan/workstream step, or synthesize when you receive \`[Plan Complete]\` / \`[Workstreams Complete]\`. Never emit acknowledgment-only text, never claim a teammate "timed out" (say "still waiting on @<name>"), and never greet/re-introduce yourself after a pause — resume mid-conversation.
Your full delegation examples, anti-patterns, and DO/DON'T list live in your \`AGENTS.md\` / \`CLAWBOO.md\` — consult them; they are authoritative.
[End Your Rules]`
}
