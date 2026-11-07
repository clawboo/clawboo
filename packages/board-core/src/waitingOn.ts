// ─── What a waiting task waits for ──────────────────────────────────────────
// A task in Blocked (or In review) used to carry no reason: "blocked" read as a
// person's job whatever the cause. `waiting_on` names it, as a small JSON value
// on the task (`tasks.waiting_on`): a kind plus what it points at. The kinds:
//
//   · person       a person must do something (`need` says what); `personId` is
//                  who, when an agent handed the task back to someone;
//   · question     an agent asked a person and waits for the answer;
//   · approval     a tool call waits for a person's decision;
//   · task         another task must finish first;
//   · subtasks     the task's own sub-tasks must finish first;
//   · failure      a run failed (the run ledger says how);
//   · verification a check on the work: running, could not run, failed, cut
//                  short by a restart, passed with Done refused, or waiting for
//                  its move to Blocked to land;
//   · budget, breaker  a budget cap or the circuit breaker stopped it;
//   · recovery     a restart found it mid-review with no run behind it.
//
// Import-free, like the state machine, so the board UI reads it too.

export type VerificationWait =
  'running' | 'could_not_run' | 'failed' | 'cut_short' | 'done_refused' | 'park_pending'

export type WaitingOn =
  | {
      kind: 'person'
      need: string
      /** The person whose turn it is, when one was named (a hand-back). */
      personId?: string | null
      /** Who put the task in this state: an agent's hand-back or a person. */
      by?: 'agent' | 'person'
    }
  | { kind: 'question'; questionId: string }
  | { kind: 'approval'; approvalId?: string | null }
  | { kind: 'task'; taskId: string }
  | { kind: 'subtasks' }
  | { kind: 'failure' }
  | { kind: 'verification'; state: VerificationWait }
  | { kind: 'budget' }
  | { kind: 'breaker' }
  | { kind: 'recovery' }

export type WaitingOnKind = WaitingOn['kind']

const VERIFICATION_WAITS: readonly VerificationWait[] = [
  'running',
  'could_not_run',
  'failed',
  'cut_short',
  'done_refused',
  'park_pending',
]

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The reason a column (or an already-parsed value) holds, or null for none and
 *  for anything it cannot read. A kind that names something must name it. */
export function parseWaitingOn(raw: unknown): WaitingOn | null {
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
  switch (d['kind']) {
    case 'person': {
      const need = str(d['need'])
      if (!need) return null
      const personId = str(d['personId'])
      const by = d['by'] === 'agent' || d['by'] === 'person' ? d['by'] : null
      return {
        kind: 'person',
        need,
        ...(personId ? { personId } : {}),
        ...(by ? { by } : {}),
      }
    }
    case 'question': {
      const questionId = str(d['questionId'])
      return questionId ? { kind: 'question', questionId } : null
    }
    case 'approval': {
      const approvalId = str(d['approvalId'])
      return approvalId ? { kind: 'approval', approvalId } : { kind: 'approval' }
    }
    case 'task': {
      const taskId = str(d['taskId'])
      return taskId ? { kind: 'task', taskId } : null
    }
    case 'verification': {
      const state = d['state']
      return VERIFICATION_WAITS.includes(state as VerificationWait)
        ? { kind: 'verification', state: state as VerificationWait }
        : null
    }
    case 'subtasks':
    case 'failure':
    case 'budget':
    case 'breaker':
    case 'recovery':
      return { kind: d['kind'] }
    default:
      return null
  }
}

/** The column value for a reason, or null for none. */
export function waitingOnJson(w: WaitingOn | null | undefined): string | null {
  return w ? JSON.stringify(w) : null
}

/** Waits on other work (another task, or its own sub-tasks): the board moves it
 *  on when that work finishes, so it does not need a person. */
export function waitsOnOtherWork(w: WaitingOn | null | undefined): boolean {
  return w?.kind === 'task' || w?.kind === 'subtasks'
}
