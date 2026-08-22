// Structured-tag utilities for the lifecycle-event orchestration path.
//
// Agents are instructed (via AGENTS.md / buildTeamAgentsMd) to emit structured
// directives — `<delegate to="@Name">task</delegate>` for one-shot delegations
// and `<plan><step to="@Name">task</step>…</plan>` for multi-step plans. These
// are parsed ONCE from a terminal turn summary and turned into durable board
// tasks (see boardOrchestration.ts). `sessions_send` tool-calls are the other
// structured signal; resolveSessionsSendTarget maps one to a team member.
//
// This module is pure parsing/stripping of the structured contract — it does
// NOT scan prose for natural-language intent.

// ─── Delegation tags ─────────────────────────────────────────────────────────

export interface DelegationIntent {
  targetAgentName: string
  targetAgentId: string
  taskDescription: string
  sourceAgentId: string
  mentionOffset: number
}

/**
 * Raw `<delegate>` block with character offsets — used by both the structured
 * parser and the UI renderer to strip / replace in-place.
 */
export interface DelegationBlock {
  /** The name as written inside `to="..."` (the leading `@` is optional). */
  targetName: string
  /** Body text between the open and close tags, trimmed. */
  task: string
  /** Index of the opening `<` of `<delegate ...>`. */
  blockStart: number
  /** Index immediately AFTER the closing `>` of `</delegate>`. */
  blockEnd: number
}

/** One `<open …>body</close>` pair located in a text. */
interface TagBlock {
  /** The opening tag's match, for its capture groups. */
  open: RegExpMatchArray
  /** Offset of the first character of the opening tag. */
  start: number
  /** Offset immediately AFTER the closing tag. */
  end: number
  /** Text between the opening and closing tags. */
  body: string
  /** Offset of the first character of `body`. */
  bodyStart: number
}

/**
 * Pair every opening tag with the next unused closing tag, in one forward pass.
 *
 * The alternative, one regex holding opener, `[\s\S]*?` body and closer, makes
 * every opener that has no closer behind it re-scan the whole remaining text,
 * and a mangled tag stream from a weak model is exactly the input that produces
 * a pile of unclosed openers. Collecting the closers once and walking a pointer
 * through them costs a single pass however lopsided the tags are.
 */
function findTagBlocks(text: string, openRe: RegExp, closeRe: RegExp): TagBlock[] {
  const closes = [...text.matchAll(closeRe)]
  if (closes.length === 0) return []
  const blocks: TagBlock[] = []
  let cursor = 0
  let next = 0
  for (const open of text.matchAll(openRe)) {
    const at = open.index ?? 0
    if (at < cursor) continue
    const bodyStart = at + open[0].length
    while (next < closes.length && (closes[next]?.index ?? 0) < bodyStart) next++
    const close = closes[next]
    if (!close) break
    const end = (close.index ?? 0) + close[0].length
    blocks.push({ open, start: at, end, body: text.slice(bodyStart, close.index ?? 0), bodyStart })
    cursor = end
  }
  return blocks
}

/** Remove `blocks` from `text`, keeping the prose around them. */
function stripTagBlocks(text: string, blocks: TagBlock[]): string {
  if (blocks.length === 0) return text.trim()
  let out = ''
  let cursor = 0
  for (const block of blocks) {
    out += text.slice(cursor, block.start)
    cursor = block.end
  }
  return (out + text.slice(cursor)).trim()
}

// Match `<delegate to="…">…</delegate>`, case-insensitive, multi-line body.
// `[^"]+` for the `to` attribute keeps it simple — agent names don't contain
// double-quotes. The body may span lines and is bounded by the closing tag.
//
// The ENTIRE opening `<delegate ` is optional (`(?:<?\s*delegate\s+)?`). The
// reliable anchor is the closing `</delegate>` plus the `to="…">` attribute
// shape — weaker models always emit those but mangle the opening tag in varied
// ways (observed live with minimax across two runs: `delegate to="@X">…</delegate>`
// with the `<` dropped, AND `to="@X">…</delegate>` with the whole `<delegate`
// dropped). Prose effectively never contains `to="…">…</delegate>`, so anchoring
// on it recovers these drifts without risking false positives. This is the
// shared regex behind BOTH the structured board derivation
// (`parseStructuredDelegations`) and the DelegationCard rendering
// (`splitAssistantText`); keeping the optional `<delegate ` inside the match (not
// just looking past it) means `stripDelegationBlocks` removes the whole tag, so
// no opening-tag fragment leaks into the rendered prose.
// Tolerate straight, single, and curly/smart quotes around the `to=` value —
// weaker models (and copy-paste from rich editors) emit `to='@X'` / `to=“@X”`.
// The whitespace runs inside the opener are length-capped: a real tag carries a
// space or two, and leaving them open-ended lets a long run of blanks be
// re-measured from every offset inside it.
const DELEGATE_OPEN_RE = /(?:<?\s{0,8}delegate\s{1,8})?to=["'“”‘’]([^"'“”‘’]+)["'“”‘’]>/gi
const DELEGATE_CLOSE_RE = /<\/delegate>/gi

/**
 * Loose detector for a delegation/plan ATTEMPT — a `<delegate>`/`<plan>`/`<step>`
 * tag shape or a `delegate to=` opener. Used by the orchestrator to tell when a
 * turn TRIED to delegate but the strict parser yielded nothing (mangled/unclosed
 * tag, unknown name), so the delegator can be nudged to re-issue instead of
 * waiting forever. Prose without a tag shape (e.g. "I'll delegate this later")
 * does NOT match — it requires the `<` tag context or the `to=` attribute.
 */
const DELEGATION_INTENT_RE = /<\/?\s*(?:delegate|plan|step)\b|\bdelegate\s+to\s*=/i

export function detectDelegationIntent(text: string): boolean {
  return DELEGATION_INTENT_RE.test(text)
}

/**
 * Find every `<delegate to="@Name">…</delegate>` block in the text. Returns
 * blocks in order of appearance. Agent-name resolution against the team roster
 * is the caller's responsibility — this function is purely a structured-tag
 * extractor.
 */
export function findDelegationBlocks(text: string): DelegationBlock[] {
  // matchAll operates on a clone, so the shared module-level regexes' lastIndex
  // is never mutated across calls.
  return findTagBlocks(text, DELEGATE_OPEN_RE, DELEGATE_CLOSE_RE).map((block) => ({
    targetName: (block.open[1] ?? '').trim(),
    task: block.body.trim(),
    blockStart: block.start,
    blockEnd: block.end,
  }))
}

/**
 * Resolve a `to="..."` attribute value against the team roster. Tolerates an
 * optional leading `@` and is case-insensitive. Uses longest-prefix match so
 * partial names ("Bug Fixer") still resolve to their full counterpart
 * ("Bug Fixer Boo") when both exist.
 */
function resolveTargetName(
  raw: string,
  teamAgents: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const stripped = raw.replace(/^@/, '').trim().toLowerCase()
  if (!stripped) return null
  const sorted = [...teamAgents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of sorted) {
    const lower = agent.name.toLowerCase()
    if (stripped === lower) return agent
  }
  // Fall back to longest-prefix match (handles "Bug Fixer" → "Bug Fixer Boo")
  for (const agent of sorted) {
    const lower = agent.name.toLowerCase()
    if (stripped.startsWith(lower) || lower.startsWith(stripped)) return agent
  }
  return null
}

/**
 * Extract delegation intents from `<delegate>` blocks. Filters: unknown target
 * (not in `teamAgents`), self-delegation, empty task body. Returns intents in
 * source order; if the same agent is targeted twice, both delegations are kept
 * (when the agent explicitly emits two structured directives we take them at
 * face value).
 */
export function parseStructuredDelegations(
  responseText: string,
  sourceAgentId: string,
  teamAgents: Array<{ id: string; name: string }>,
): DelegationIntent[] {
  const blocks = findDelegationBlocks(responseText)
  if (blocks.length === 0) return []

  const intents: DelegationIntent[] = []
  for (const block of blocks) {
    if (!block.task) continue
    const target = resolveTargetName(block.targetName, teamAgents)
    if (!target) continue
    if (target.id === sourceAgentId) continue
    intents.push({
      targetAgentName: target.name,
      targetAgentId: target.id,
      taskDescription: block.task,
      sourceAgentId,
      mentionOffset: block.blockStart,
    })
  }
  return intents
}

/**
 * Strip every `<delegate>…</delegate>` block from the text. Used by the UI
 * renderer to produce the prose-only segment that gets fed through the markdown
 * pipeline (the blocks themselves render as styled "Delegated to @Name" cards /
 * durable board tasks instead).
 */
export function stripDelegationBlocks(text: string): string {
  return stripTagBlocks(text, findTagBlocks(text, DELEGATE_OPEN_RE, DELEGATE_CLOSE_RE))
}

// ─── Plan tags ───────────────────────────────────────────────────────────────
//
// A `<plan>` block contains one or more `<step to="@Name">task</step>` children.
// Plans become durable board task dependency chains; a ready-pump fires the next
// step when its blocker completes.

export interface PlanStep {
  /** The name as written inside `to="…"` (optional leading `@`). */
  targetName: string
  /** Body text between the open and close tags, trimmed. */
  task: string
  /** Character offset of the `<step` opener, relative to the source text. */
  stepStart: number
  /** Index immediately AFTER the closing `>` of `</step>`. */
  stepEnd: number
}

export interface PlanBlock {
  /** Character offset of the `<plan>` opener in the source text. */
  blockStart: number
  /** Index immediately AFTER the closing `>` of `</plan>`. */
  blockEnd: number
  /** Steps in source order. May be empty when the LLM emitted an empty plan. */
  steps: PlanStep[]
}

// Match `<plan>…</plan>`, case-insensitive, multi-line body. The opening `<` is
// optional (`<?`): like `<delegate>`, weaker models reliably emit the closing
// `</plan>` but sometimes drop the leading `<` of the opener (e.g. `plan>…</plan>`).
// The `</plan>` close + the literal `plan` keyword anchor it, so prose never
// false-matches.
const PLAN_OPEN_RE = /<?\s{0,8}plan(?:\s[^>]*)?>/gi
const PLAN_CLOSE_RE = /<\/plan>/gi

// Match `<step to="…">…</step>` inside a plan body. Mirrors the `<delegate>`
// drift tolerance exactly (same `to="…">…<close>` shape): the ENTIRE opening
// `<step ` is optional, anchored on the closing `</step>` + the `to="…">`
// attribute shape — recovers both `step to="@X">…</step>` (dropped `<`) and
// `to="@X">…</step>` (dropped the whole `<step`).
const STEP_OPEN_RE = /(?:<?\s{0,8}step\s{1,8})?to=["'“”‘’]([^"'“”‘’]+)["'“”‘’]>/gi
const STEP_CLOSE_RE = /<\/step>/gi

/**
 * Find every `<plan>` block in the text and parse its `<step>` children.
 * Returns blocks in source order. Empty plans (`<plan></plan>`) come back with
 * `steps: []` so the caller can decide whether to ignore them.
 */
export function findPlanBlocks(text: string): PlanBlock[] {
  const blocks: PlanBlock[] = []
  for (const plan of findTagBlocks(text, PLAN_OPEN_RE, PLAN_CLOSE_RE)) {
    const steps: PlanStep[] = []
    for (const step of findTagBlocks(plan.body, STEP_OPEN_RE, STEP_CLOSE_RE)) {
      const targetName = (step.open[1] ?? '').trim()
      const task = step.body.trim()
      if (!targetName || !task) continue
      // Translate the step's offset within the plan body back to an absolute
      // offset in the original text so downstream consumers can splice.
      steps.push({
        targetName,
        task,
        stepStart: plan.bodyStart + step.start,
        stepEnd: plan.bodyStart + step.end,
      })
    }
    blocks.push({ blockStart: plan.start, blockEnd: plan.end, steps })
  }
  return blocks
}

/**
 * Strip every `<plan>…</plan>` block from the text. Used by the renderer when
 * producing the plain-text segment between board cards (mirror of
 * `stripDelegationBlocks`).
 */
export function stripPlanBlocks(text: string): string {
  return stripTagBlocks(text, findTagBlocks(text, PLAN_OPEN_RE, PLAN_CLOSE_RE))
}

// ─── sessions_send target resolution ─────────────────────────────────────────

export interface SessionsSendParams {
  /** `agent:<id>:<sessionName>` format, when the caller used a direct key. */
  sessionKey?: string
  /** Human-readable label — typically the agent's `name`. */
  label?: string
  /** Direct agent id when present. */
  agentId?: string
  /** Required body. */
  message: string
}

/**
 * Resolve a `sessions_send` target against the team roster. Tries in priority
 * order:
 *   1. `sessionKey` — parse `agent:<id>:<sessionName>` and look up by id.
 *   2. `agentId` — direct id match.
 *   3. `label` — case-insensitive name match against participants.
 * Returns the resolved participant or null.
 */
export function resolveSessionsSendTarget(
  params: SessionsSendParams,
  participants: { id: string; name: string }[],
): { id: string; name: string } | null {
  if (params.sessionKey) {
    const match = params.sessionKey.match(/^agent:([^:]+):/)
    const id = match?.[1]
    if (id) {
      const hit = participants.find((p) => p.id === id)
      if (hit) return hit
    }
  }
  if (params.agentId) {
    const hit = participants.find((p) => p.id === params.agentId)
    if (hit) return hit
  }
  if (params.label) {
    const lower = params.label.toLowerCase()
    const exact = participants.find((p) => p.name.toLowerCase() === lower)
    if (exact) return exact
    // Tolerate leading `@` and longest-prefix.
    const stripped = params.label.replace(/^@/, '').trim().toLowerCase()
    const sorted = [...participants].sort((a, b) => b.name.length - a.name.length)
    for (const p of sorted) {
      if (stripped === p.name.toLowerCase()) return p
    }
    for (const p of sorted) {
      const lp = p.name.toLowerCase()
      if (stripped.startsWith(lp) || lp.startsWith(stripped)) return p
    }
  }
  return null
}
