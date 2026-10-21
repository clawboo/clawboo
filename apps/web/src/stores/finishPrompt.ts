import { create } from 'zustand'

// Imperative prompt for a person finishing a task by hand (Done or Cancelled):
// which day it finished, and a confirmation when the move cannot be undone, stops
// an agent's run or overrides a failed check. The <FinishPromptDialog/> mounted at
// the app root reads this store; a caller does
//   const choice = await askFinish({ ... })
//   if (!choice) return

export interface FinishPromptRequest {
  to: 'done' | 'cancelled'
  /** The task's title, for the heading. */
  title: string
  /** Start of the day the card sits on, or null when that is today (no day to pick). */
  sitsOn: number | null
  /** When the task was added: the earliest day it can have finished. */
  createdAt: number | null
  /** The agent whose run the move stops, when one is working on it. */
  runningAgent: string | null
  /** Its check did not pass, so marking it done is an audited override. */
  failedCheck: boolean
  /** The clock the choices are worked out from. */
  now: number
  /** First day of the week in the little calendar, in `Date#getDay` numbering. */
  weekStartsOn: number
}

export interface FinishChoice {
  /** The day picked, as its start; today's start when no day was offered. */
  day: number
}

interface FinishPromptStore {
  open: boolean
  /** Kept through the exit animation; overwritten by the next request. */
  request: FinishPromptRequest | null
  resolver: ((choice: FinishChoice | null) => void) | null
  ask: (request: FinishPromptRequest) => Promise<FinishChoice | null>
  /** Resolve the pending request and close (null = the person backed out). */
  settle: (choice: FinishChoice | null) => void
}

export const useFinishPromptStore = create<FinishPromptStore>((set, get) => ({
  open: false,
  request: null,
  resolver: null,
  ask: (request) =>
    new Promise<FinishChoice | null>((resolve) => {
      get().resolver?.(null)
      set({ open: true, request, resolver: resolve })
    }),
  settle: (choice) => {
    const r = get().resolver
    set({ open: false, resolver: null })
    r?.(choice)
  },
}))

/** Ask the person how to finish a task. Resolves null when they back out. */
export function askFinish(request: FinishPromptRequest): Promise<FinishChoice | null> {
  return useFinishPromptStore.getState().ask(request)
}
