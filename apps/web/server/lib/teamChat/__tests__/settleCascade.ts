// Settles a team cascade that runs under fake timers. The suites that use it wire
// the real engine, the real run primitive and the real board, and fake only
// `setTimeout` and `setInterval`, so a cascade mixes timer-gated stages (the 3s
// reflect batch) with whatever real I/O its runs do (a persistent-home run makes
// its home directory with `mkdir` before it starts).
//
// Stepping fake time blind lets it outrun that I/O: a 90s fake budget (360 steps)
// runs out in tens of milliseconds of real time, so on a slow Windows runner a
// worker whose `mkdir` took longer had not even started when the test asserted
// (#306). Use this helper rather than a local copy, so a suite whose runs start
// touching the disk later is covered without anyone noticing.
//
// Child processes count too: the team chat's work check runs `git` and the team's
// verify command, which on a loaded Windows runner take seconds each. A child that
// is still running is listed as a `ProcessWrap` until it exits (its pipes are
// `PipeWrap`, which also covers vitest's own channel, so pipes are not waited on).

import { vi } from 'vitest'

import { REFLECT_WINDOW_MS } from '@clawboo/team-orchestration'

/** True while a real fs request (an `fs` or `fs/promises` call) has not completed,
 *  or a child process this test started is still running. */
const ioInFlight = (): boolean =>
  process.getActiveResourcesInfo().some((r) => r.startsWith('FSReq') || r === 'ProcessWrap')

/** Run the cascade until `until()` holds: advance fake time in small steps, and never
 *  while real I/O (an fs request, a child process) is in flight. Waiting it out
 *  before each step keeps timers and I/O in production order on any runner, so the
 *  fake time a cascade uses is fixed (a few reflect windows). Bounded by real time
 *  as well as fake time, and it throws naming `what` instead of letting the
 *  assertions run early. */
export async function settle(
  until: () => boolean,
  what: string,
  fakeBudgetMs = 30 * REFLECT_WINDOW_MS,
  realBudgetMs = 20_000,
): Promise<void> {
  const step = 250
  const startedAt = performance.now()
  const deadline = startedAt + realBudgetMs
  // Real macrotask turns (I/O completions run between them) until no fs request or
  // child process is left in flight, so the caller also asserts on settled state.
  const quiesce = async (): Promise<void> => {
    do {
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    } while (ioInFlight() && performance.now() < deadline)
  }
  let fakeMs = 0
  await quiesce()
  while (!until()) {
    if (fakeMs >= fakeBudgetMs || performance.now() >= deadline) {
      const realMs = Math.round(performance.now() - startedAt)
      throw new Error(
        `settle: ${what} did not happen after ${fakeMs} ms fake / ${realMs} ms real` +
          (ioInFlight() ? ' (an fs request or a child process is still in flight)' : ''),
      )
    }
    await vi.advanceTimersByTimeAsync(step)
    fakeMs += step
    await quiesce()
  }
}
