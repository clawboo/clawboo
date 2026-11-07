// ─── Plans ──────────────────────────────────────────────────────────────────
// A plan is a document on a task (`task_documents`, key `plan`), and on a team that
// asks first, a list of steps waiting for a person as a "suggest tasks" question.
// These rules are import-free so the server, the Tasks tools and the board's answer
// controls read one definition.

import { encodeHumanAssignment } from './dispatch'
import type { QuestionPayload, SuggestedTask } from './questions'
import { HAND_OFF_TITLE_CHARS, normalizeTaskTitle } from './taskIdentifier'

/** The one document key today. */
export const TASK_DOCUMENT_PLAN_KEY = 'plan'
/** Longest body one revision may hold. */
export const TASK_DOCUMENT_MAX_CHARS = 32_000
/** Most revisions one task keeps for one key. Old ones are never trimmed, so a writer
 *  stuck in a loop is refused rather than growing the row count without end. */
export const TASK_DOCUMENT_MAX_REVISIONS = 100
/** How much of a step's own words the rendered plan shows. The whole step stays on the
 *  question, and this keeps a plan of the most steps under the body limit. */
const RENDERED_STEP_CHARS = 800

/** A step as an accepted plan creates it: it always goes to someone. */
export interface AcceptedPlanStep {
  title: string
  description?: string
  agentId: string
}

const PLAN_HOLDER_NONCE = 'plan-holder-'

/**
 * The `sourceDelegationId` of a card that only holds a plan, for a turn with no task of
 * its own. It reads as a person's assignment, so nothing reports up from it. An answer
 * closes it without a run; it runs only if a person moves it back to To do.
 */
export function encodePlanHolder(agentId: string, nonce: string): string {
  return encodeHumanAssignment(agentId, `${PLAN_HOLDER_NONCE}${nonce}`)
}

/** Is this a card that only holds a plan? It did no work, so nothing checks it. */
export function isPlanHolder(sourceDelegationId: string | null | undefined): boolean {
  return !!sourceDelegationId && sourceDelegationId.startsWith(`assign:${PLAN_HOLDER_NONCE}`)
}

/** Does this question carry a plan, whose acceptance creates its steps? */
export function planWaitsForPerson(payload: QuestionPayload): boolean {
  return payload.plan !== undefined
}

const askOf = (step: SuggestedTask): string =>
  `${step.agentId ?? ''}\n${normalizeTaskTitle(step.description ?? step.title)}`

/** Are these the same steps, in the same order? A re-issue with other words or another
 *  target is a new plan. A name is not part of it: agents get renamed. */
export function planStepsMatch(a: readonly SuggestedTask[], b: readonly SuggestedTask[]): boolean {
  return a.length === b.length && a.every((step, i) => askOf(step) === askOf(b[i]!))
}

/** The steps as a numbered list, for a plan its agent wrote nothing else for. */
export function renderPlanBody(steps: readonly SuggestedTask[]): string {
  return steps
    .map((step, i) => {
      const who = step.agentName ? ` (${step.agentName})` : ''
      const words = step.description?.trim()
      if (!words || words === step.title) return `${i + 1}. ${step.title}${who}`
      const shown =
        words.length > RENDERED_STEP_CHARS ? `${words.slice(0, RENDERED_STEP_CHARS)}…` : words
      return `${i + 1}. ${step.title}${who}\n   ${shown.replace(/\n/g, '\n   ')}`
    })
    .join('\n')
}

/**
 * What an accepted plan creates from what the person sent. What runs is what they saw:
 * the description, or the title when there is none, with the title only ever the start of
 * it, so what they took out of a step reaches no one. A target the plan did not name is
 * not honoured, so a request body cannot hand work to anyone new, and a step with none
 * goes to the agent that proposed it. Words too long for a title are kept whole.
 */
export function acceptedPlanSteps(
  proposed: readonly SuggestedTask[],
  answered: readonly SuggestedTask[],
  proposer: string,
): AcceptedPlanStep[] {
  const targets = new Set(proposed.map((s) => s.agentId).filter(Boolean))
  return answered.map((step) => {
    const agentId = step.agentId && targets.has(step.agentId) ? step.agentId : proposer
    const words = step.description ?? step.title
    const text = words.startsWith(step.title) ? words : `${step.title}\n\n${words}`
    const title = step.title.slice(0, HAND_OFF_TITLE_CHARS)
    return { title, ...(text !== title ? { description: text } : {}), agentId }
  })
}
