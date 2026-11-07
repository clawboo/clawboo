// A delivery the host refused to start, for a reason a person should read.
//
// `deliver` rejects whenever a run could not start. Most rejections are faults
// (a runtime that is not connected, a start that threw), and the engine words
// those itself. A refusal is a decision: the host looked and chose not to start
// the run, for example because a hard-cap budget covering it is paused. Its
// message says why in words fit for the board and the chat, so the engine
// records it as the failure instead of a generic "could not deliver".

export class DeliveryRefusedError extends Error {
  /** A hard budget cap refused it: not a run without progress, and a wake it carried
   *  waits instead of counting a replay. */
  readonly budget: boolean
  /** Which refusal: `paused` waits for a person to raise the cap, and `held` clears by
   *  itself when the runs that set aside the cap's room end. */
  readonly budgetReason: 'paused' | 'held'

  constructor(message: string, opts: { budget?: boolean; budgetReason?: 'paused' | 'held' } = {}) {
    super(message)
    this.name = 'DeliveryRefusedError'
    this.budget = opts.budget === true
    this.budgetReason = opts.budgetReason ?? 'paused'
  }
}

/** The code on the terminal a host sends for a budget refusal that reached the engine
 *  as a run's own ending. Not one of the policy-denial codes: nothing was denied. */
export const BUDGET_REFUSED_CODE = 'budget_refused'

/** The same, for a budget whose room runs already going have set aside. */
export const BUDGET_HELD_CODE = 'budget_held'
