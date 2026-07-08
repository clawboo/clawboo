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

// Match `<delegate to="…">…</delegate>`, case-insensitive, multi-line body.
// `[^"]+` for the `to` attribute keeps it simple — agent names don't contain
// double-quotes. The non-greedy `[\s\S]*?` body handles multi-line tasks.
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
const DELEGATE_TAG_RE =
  /(?:<?\s*delegate\s+)?to=["'“”‘’]([^"'“”‘’]+)["'“”‘’]>([\s\S]*?)<\/delegate>/gi

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
  const blocks: DelegationBlock[] = []
  // matchAll operates on a clone, so the shared module-level regex's lastIndex
  // is never mutated across calls.
  for (const m of text.matchAll(DELEGATE_TAG_RE)) {
    const targetName = (m[1] ?? '').trim()
    const task = (m[2] ?? '').trim()
    const blockStart = m.index ?? 0
    blocks.push({
      targetName,
      task,
      blockStart,
      blockEnd: blockStart + m[0].length,
    })
  }
  return blocks
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
  return text.replace(DELEGATE_TAG_RE, '').trim()
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
const PLAN_TAG_RE = /<?\s*plan(?:\s[^>]*)?>([\s\S]*?)<\/plan>/gi

// Match `<step to="…">…</step>` inside a plan body. Mirrors the `<delegate>`
// drift tolerance exactly (same `to="…">…<close>` shape): the ENTIRE opening
// `<step ` is optional, anchored on the closing `</step>` + the `to="…">`
// attribute shape — recovers both `step to="@X">…</step>` (dropped `<`) and
// `to="@X">…</step>` (dropped the whole `<step`).
const STEP_TAG_RE = /(?:<?\s*step\s+)?to=["'“”‘’]([^"'“”‘’]+)["'“”‘’]>([\s\S]*?)<\/step>/gi

/**
 * Find every `<plan>` block in the text and parse its `<step>` children.
 * Returns blocks in source order. Empty plans (`<plan></plan>`) come back with
 * `steps: []` so the caller can decide whether to ignore them.
 */
export function findPlanBlocks(text: string): PlanBlock[] {
  const blocks: PlanBlock[] = []
  for (const planMatch of text.matchAll(PLAN_TAG_RE)) {
    const matchIndex = planMatch.index ?? 0
    const matchText = planMatch[0]
    const blockStart = matchIndex
    const blockEnd = matchIndex + matchText.length
    const planInnerStart = matchIndex + matchText.indexOf('>') + 1
    const planBody = planMatch[1] ?? ''

    const steps: PlanStep[] = []
    for (const stepMatch of planBody.matchAll(STEP_TAG_RE)) {
      const targetName = (stepMatch[1] ?? '').trim()
      const task = (stepMatch[2] ?? '').trim()
      if (!targetName || !task) continue
      // Translate the step's offset within `planBody` back to an absolute
      // offset in the original text so downstream consumers can splice.
      const stepStart = planInnerStart + (stepMatch.index ?? 0)
      const stepEnd = stepStart + stepMatch[0].length
      steps.push({ targetName, task, stepStart, stepEnd })
    }

    blocks.push({ blockStart, blockEnd, steps })
  }
  return blocks
}

/**
 * Strip every `<plan>…</plan>` block from the text. Used by the renderer when
 * producing the plain-text segment between board cards (mirror of
 * `stripDelegationBlocks`).
 */
export function stripPlanBlocks(text: string): string {
  return text.replace(PLAN_TAG_RE, '').trim()
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
