// Plan parser — Round 8B explicit multi-step orchestration.
//
// A `<plan>` block contains one or more `<step to="@Name">task</step>`
// children. Clawboo parses these out of the leader's response, persists the
// plan to the chat store, fires step 1, and on each subsequent specialist
// relay auto-fires the next step. When all steps complete, the leader
// receives a `[Plan Complete]` envelope cueing final synthesis.
//
// Syntax (verbatim from the rules block — kept in sync intentionally):
//
//   <plan>
//     <step to="@Marketing Content Creator Boo">Write the copy first.</step>
//     <step to="@Design Ui Designer Boo">Create the visual design from the copy.</step>
//     <step to="@Engineering Frontend Developer Boo">Build the page from the design.</step>
//   </plan>
//
// Why a separate parser instead of extending `findDelegationBlocks`:
//   • `<plan>` is a CONTAINER of steps — its semantics are stateful (auto-
//     progression across turns) while `<delegate>` is one-shot.
//   • Mixing them risks double-routing: step 1 would fire from BOTH the plan
//     scanner AND the `<delegate>` scanner if `<step>` looked like a
//     delegate.
//   • Keeping them in distinct modules lets `useTeamOrchestration` decide
//     which path to take (plan state-machine vs. one-shot dispatch) based on
//     what the leader actually emitted.

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

// Match `<plan>…</plan>`, case-insensitive, multi-line body.
const PLAN_TAG_RE = /<plan(?:\s[^>]*)?>([\s\S]*?)<\/plan>/gi

// Match `<step to="…">…</step>` inside a plan body.
const STEP_TAG_RE = /<step\s+to="([^"]+)">([\s\S]*?)<\/step>/gi

/**
 * Find every `<plan>` block in the text and parse its `<step>` children.
 * Returns blocks in source order. Empty plans (`<plan></plan>`) come back
 * with `steps: []` so the caller can decide whether to ignore them.
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
 * Strip every `<plan>…</plan>` block from the text. Used by the renderer
 * when producing the plain-text segment between plan-step cards (mirror of
 * `stripDelegationBlocks` in `delegationDetector.ts`).
 */
export function stripPlanBlocks(text: string): string {
  return text.replace(PLAN_TAG_RE, '').trim()
}
