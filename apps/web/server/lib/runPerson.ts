// The run's person: whose run this is. ONE answer, decided here and nowhere else.
//
// Whatever needs to know on whose behalf a run acts (which saved website logins
// its agent may fill, and later whose provider credentials it uses and whose
// computer it may borrow) asks `runPersonOf`. Nothing reads `tasks.requested_by`
// or `req.person` for that purpose by itself, so a change to how people are
// identified lands in one place.
//
// The order (the per-run credentials design, section 4.2, with the owner's D1
// and D7 of 11 November 2026):
//   1. the person who started this run: a person's chat message, a Retry or
//      Assign click (a Retry is the retrier's run), the REST run;
//   2. the routine's creating person, for a routine that runs as its creator.
//      Routines do not record their creator yet, so no call site passes one and a
//      routine's run belongs to no one;
//   3. the requester of the run's task, or of its nearest ancestor that names
//      one, unless a routine fired that task or one above it. Never the built-in
//      local person as a fallback;
//   4. no one.
//
// ON AN INSTALL WITH ONE PERSON there is no separate fallback, on purpose. Every
// path a person starts already names the built-in local person when nothing else
// vouched (the dashboard acts as that person, `actingPerson`), and so does every
// task they ask for. What names no one is exactly what no person started: a
// routine and the work it hands out, a task an agent made on its own, a call that
// failed the person check. A blanket "the one person" fallback would hand those
// the person's logins, so the answer has to come from evidence.
//
// Alongside it, the run reference: a random id a run site registers with the
// answer when the run starts, signed onto the run's Tools attach URL, and
// released when the run ends. A tool that acts for the run's person (the login
// fill) looks the answer up by that reference. A call with no live reference
// gets no person, so a run path that never registered fails closed.

import { randomBytes } from 'node:crypto'

import { requesterOfTask, taskTreeFiredByRoutine, type ClawbooDb } from '@clawboo/db'
import type { PersonRef } from '@clawboo/protocol'

export type RunPersonBasis = 'started' | 'routine_creator' | 'task_requester' | 'none'

export interface RunPerson {
  person: PersonRef | null
  basis: RunPersonBasis
}

export interface RunPersonInput {
  /** The person whose request started this run: one a sign-in proxy vouched for, or
   *  the dashboard's own person (`actingPerson`) for a request that passed the person
   *  check. A Retry passes the retrier. Null or absent for anything else. */
  startedBy?: PersonRef | null
  /** The board task the run works on, when it has one. */
  taskId?: string | null
  /** Set for a routine's fire. `runAsCreator` with a `createdBy` is the routine
   *  running on its maker's account (D7); routines cannot record that yet. */
  routine?: { createdBy: PersonRef | null; runAsCreator: boolean } | null
  /** Needed to read a task's requester. */
  db?: ClawbooDb | null
}

const NO_ONE: RunPerson = Object.freeze({ person: null, basis: 'none' })

function copyPerson(p: PersonRef): PersonRef {
  return { id: p.id, name: p.name ?? null, role: p.role ?? null }
}

/** Whose run this is. See the top of this file for the order. */
export function runPersonOf(input: RunPersonInput): RunPerson {
  if (input.startedBy && input.startedBy.id) {
    return { person: copyPerson(input.startedBy), basis: 'started' }
  }
  if (input.routine) {
    const { createdBy, runAsCreator } = input.routine
    if (runAsCreator && createdBy && createdBy.id) {
      return { person: copyPerson(createdBy), basis: 'routine_creator' }
    }
    return NO_ONE
  }
  const db = input.db ?? null
  const taskId = input.taskId ?? null
  if (db && taskId) {
    // A routine's tree belongs to no one, even a task a person asked for that a
    // routine now fires.
    if (taskTreeFiredByRoutine(db, taskId)) return NO_ONE
    const asked = requesterOfTask(db, taskId)
    if (asked) return { person: copyPerson(asked.person), basis: 'task_requester' }
  }
  return NO_ONE
}

// ─── Run references ─────────────────────────────────────────────────────────

interface LiveRun {
  agentId: string
  runPerson: RunPerson
  openedAt: number
}

/** A backstop for a run site that never released: no run lives this long. */
const RUN_REF_TTL_MS = 24 * 60 * 60_000
/** And a bound on the map, oldest dropped first. */
const MAX_LIVE_RUNS = 10_000

const liveRuns = new Map<string, LiveRun>()

function sweep(now: number): void {
  for (const [ref, run] of liveRuns) {
    if (now - run.openedAt <= RUN_REF_TTL_MS && liveRuns.size <= MAX_LIVE_RUNS) break
    liveRuns.delete(ref)
  }
}

export interface RunRef {
  /** Random, 128 bits, base64url. Signed onto the run's Tools URL. */
  ref: string
  /** Forget it. Idempotent. Call it where the run ends, success or failure. */
  release(): void
}

/**
 * Register a run's person under a fresh reference. The run site calls this once
 * when the run starts, with `runPersonOf`'s answer, and releases it when the run
 * ends.
 */
export function openRunRef(agentId: string, runPerson: RunPerson): RunRef {
  const now = Date.now()
  sweep(now)
  const ref = randomBytes(16).toString('base64url')
  liveRuns.set(ref, {
    agentId,
    runPerson: {
      person: runPerson.person ? copyPerson(runPerson.person) : null,
      basis: runPerson.basis,
    },
    openedAt: now,
  })
  let released = false
  return {
    ref,
    release: () => {
      if (released) return
      released = true
      liveRuns.delete(ref)
    },
  }
}

/**
 * The person of the live run this reference names, when it is a run of this
 * agent. Null for an unknown, released or expired reference, or one opened for
 * another agent: a run's person never crosses to another agent's call.
 */
export function runPersonForRef(ref: string | null | undefined, agentId: string): RunPerson | null {
  if (!ref) return null
  const run = liveRuns.get(ref)
  if (!run) return null
  if (Date.now() - run.openedAt > RUN_REF_TTL_MS) {
    liveRuns.delete(ref)
    return null
  }
  if (run.agentId !== agentId) return null
  return run.runPerson
}

/** Test seam. */
export function resetRunRefsForTests(): void {
  liveRuns.clear()
}
