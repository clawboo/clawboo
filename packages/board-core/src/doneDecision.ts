// ─── Who decides Done ───────────────────────────────────────────────────────
// An agent can say how its task went (`report_result`), and the server decides. This
// is that decision, in one place, reading what the run's ending already knows.
//
// The claim is one bit on purpose: did the agent get there or not. Anything richer
// has a tool of its own that says what is next (`block_task`, `ask_person`,
// `hand_back_task`), and "needs review" has no home here: In review means a check is
// running. Import-free, like the state machine.

/** What an agent said about its task. */
export type ResultClaimOutcome = 'done' | 'not_done'

export interface ResultClaim {
  outcome: ResultClaimOutcome
  /** What it did, or, for `not_done`, why not and what a person should do next. */
  summary: string
  /** What it made, as it names them: paths, links. */
  deliverables?: string[]
}

/** A claim as a column (or an already-parsed value) holds it. Null for none and for
 *  anything it cannot read: a bad row behaves as if the tool was never called. */
export function parseResultClaim(raw: unknown): ResultClaim | null {
  let doc: unknown = raw
  if (typeof raw === 'string') {
    if (!raw) return null
    try {
      doc = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!doc || typeof doc !== 'object') return null
  const d = doc as Record<string, unknown>
  if (d['outcome'] !== 'done' && d['outcome'] !== 'not_done') return null
  if (typeof d['summary'] !== 'string') return null
  const deliverables = Array.isArray(d['deliverables'])
    ? d['deliverables'].filter((x): x is string => typeof x === 'string')
    : undefined
  return {
    outcome: d['outcome'],
    summary: d['summary'],
    ...(deliverables ? { deliverables } : {}),
  }
}

export interface DoneDecisionInput {
  /** The agent's claim for this run, or null when it never made one. */
  claim: Pick<ResultClaim, 'outcome'> | null
  /** What the team's work check said about this run. `none`: no check ran. */
  check: 'pass' | 'retry' | 'failed' | 'decided' | 'unchecked' | 'none'
  /** The stored verdict the board's Done gate reads lets the task through. True when
   *  there is none. */
  storedVerdictPasses: boolean
  /** The class the run's error was filed under, or null. */
  errorClass: string | null
  /** Sub-tasks that ended without getting done and were not cancelled. */
  unfinishedSubtasks: number
}

export type DoneDecision =
  | {
      done: true
      /** It closes over sub-tasks that did not finish, on its agent's word: say so. */
      overUnfinished: boolean
    }
  | { done: false; because: 'run_error' | 'check' | 'stored_verdict' | 'claim' | 'subtasks' }

/**
 * May this run's task be called Done? What the agent says comes after what the server
 * knows: a claim of success never overrides a failing check, a failing stored verdict
 * or a run that ended on an error. A claim of failure stops a Done that would have
 * happened. With no claim, the answer is the one the run's ending always gave, except
 * for a parent whose sub-tasks did not finish: nobody has said that is fine.
 */
export function decideDone(input: DoneDecisionInput): DoneDecision {
  if (input.errorClass !== null) return { done: false, because: 'run_error' }
  if (input.check === 'failed' || input.check === 'retry' || input.check === 'decided')
    return { done: false, because: 'check' }
  if (!input.storedVerdictPasses) return { done: false, because: 'stored_verdict' }
  if (input.claim?.outcome === 'not_done') return { done: false, because: 'claim' }
  const overUnfinished = input.unfinishedSubtasks > 0
  if (overUnfinished && input.claim?.outcome !== 'done') return { done: false, because: 'subtasks' }
  return { done: true, overUnfinished }
}
