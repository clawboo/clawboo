// Turns the worker's event loop after every test, so it reads its RPC replies.
//
// WHY THIS EXISTS. A Vitest worker reports progress to the main process over an
// RPC channel (`onTaskUpdate`), and gives each call 60 s to be answered. The
// answer arrives in the worker's I/O queue, and the worker only reads that queue
// when its event loop turns. Vitest 3's runner never turns it between tests: it
// goes from one test to the next on promise continuations alone. Half of this
// suite's tests never turn it inside the test either (better-sqlite3 is
// synchronous, and a fake-timer suite never waits on a real timer), so a run of
// such tests is one unbroken synchronous stretch. Measured on the node project:
// 2 of 3,270 tests saw a loop turn before they started, and in some files
// (runtimesInstallConnect, operatorSettings) no test turns it at all.
//
// On a quiet machine those stretches last milliseconds. On GitHub's Windows
// runner they do not: the runner has stalls in which tests that usually take
// 0.3 s there take 10 to 27 s, and a stall that lands on a stretch keeps the
// worker away from its replies for the whole stall. When that passes 60 s, the
// RPC timer fires before the reply is read, and the run ends with every test
// green and "[vitest-worker]: Timeout calling onTaskUpdate". All three failures
// on 2026-11-04 hit while boardOrchestration.contract, where 112 of 248 tests
// never turn the loop, ran through such a stall.
//
// WHAT THIS CHANGES. One turn per test bounds a worker's time away from its
// replies to a single test and its hooks, which their own timeouts already bound.
// It does not make anything faster, and it does not touch any timeout.
//
// TWO IMMEDIATES, NOT ONE. The replies are read in the loop's poll phase, and a
// setImmediate callback runs in the check phase that FOLLOWS poll. Awaited from a
// poll-phase callback, one immediate resumes in that same iteration's check phase
// without a fresh poll. Two consecutive check phases always have a poll between
// them.
//
// REAL TIMERS. The immediate is captured when this file loads, which is before
// any suite can call `vi.useFakeTimers()`. A faked setImmediate only fires when a
// test advances the fake clock, so awaiting it from a hook would hang.

import { afterEach } from 'vitest'

const realSetImmediate = globalThis.setImmediate

const nextCheckPhase = (): Promise<void> =>
  new Promise((resolve) => {
    realSetImmediate(resolve)
  })

afterEach(async () => {
  await nextCheckPhase()
  await nextCheckPhase()
})
