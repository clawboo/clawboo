// The cascade-invariant CONTRACT for the board orchestration engine — the exact
// scenarios that guarantee an agent is never left standing (stop-clean-release,
// idle watchdog, sessionToTask 1:1 serialize-don't-orphan, reflect batching,
// fan-out cap, plan-dep-cancel-on-fail, loop breakers, dedupe, claim-409-never-
// retried). Exported under the `./contract` subpath (external vitest, like
// `@clawboo/executor/contract`) so it is RUN against BOTH board implementations:
//   • the pure in-memory `FakeBoard` (packages/team-orchestration test) — proves
//     the engine's cascade logic;
//   • the REAL `serverBoardClient` over a temp SQLite (apps/web test) — proves the
//     invariants hold against the production board state machine, catching any
//     divergence between the fake's simulated transitions and the real repo.
//
// Every scenario drives the pure engine via `orchestrator.onEvent(...)` and asserts
// through the board-agnostic `CascadeBoard` inspection surface (recorded calls +
// live status reads) using DYNAMIC task ids captured from `board.created` — never a
// hardcoded `task-N`, so it runs identically whether the board issues `task-1` or a
// UUID.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  DELEGATION_IDLE_TIMEOUT_MS,
  MAX_AUTO_FIRES,
  MAX_DELEGATION_FAILURES,
  MAX_SPAWN_DEPTH,
  OPEN_TOOL_CALL_TIMEOUT_MS,
  REFLECT_WINDOW_MS,
  type BoardChange,
  type DelegationSignal,
  type KnownAgent,
} from './boardOrchestration'
import type { BoardClient, BoardTask, CompleteExecutionOutcome } from './boardClient'

// ─── The board-agnostic inspection + control surface ──────────────────────────
// A superset of `BoardClient` the contract scenarios use. Both the in-memory fake
// and the recording-wrapper over the real client implement it. Inspection is
// synchronous (the fake reads its Map; the real wrapper reads the DB / recorded
// calls); control methods simulate external actors (a stale-sweep release, a
// pre-seeded resumable task) portably across both boards.
export type SeedExecState = 'none' | 'running-openclaw' | 'running-executor'

export interface CascadeBoard extends BoardClient {
  /** Tasks created via `createTask`, in call order (source of dynamic ids). */
  readonly created: readonly BoardTask[]
  /** Task ids passed to `claim`, in order. */
  readonly claims: readonly string[]
  /** `{taskId,status}` for each successful `updateStatus` + each `cancelDependents` cancellation. */
  readonly statusUpdates: readonly { taskId: string; status: string }[]
  /** `{execId,outcome}` for each `completeExecution`. */
  readonly completed: readonly { execId: string; outcome: CompleteExecutionOutcome }[]
  /** `{taskId,body}` for each `addComment`. */
  readonly comments: readonly { taskId: string; body: string }[]
  /** Number of executions opened. */
  readonly execCount: number
  /** When true, the NEXT `claim` returns a 409 conflict (someone-else-won sim). */
  forceClaimConflict: boolean
  /** Fired at the START of `createTask` (tests bump the stop-gen mid-spawn). */
  onCreate?: () => void
  /** Fired at the START of `claim` (tests bump the stop-gen mid-claim). */
  onClaim?: () => void
  /** Current status of a task, or undefined if unknown. */
  statusOf(taskId: string): string | undefined
  /** Dependency task ids `taskId` waits on (recorded from `linkDep`). */
  depsOf(taskId: string): readonly string[]
  /** Live task count for the team. */
  taskCount(): number
  /** Live statuses of all team tasks (order not guaranteed meaningful). */
  allStatuses(): string[]
  /** Simulate an EXTERNAL release (server stale-sweep): → todo + unassigned, NOT
   *  recorded as an engine status update. */
  forceRelease(taskId: string): void
  /** Pre-seed a durable in_progress task (a refresh: in-memory maps empty, only the
   *  row survives). Returns the id. */
  seedInProgress(input: {
    title: string
    sourceDelegationId: string | null
    assigneeAgentId: string
    /**
     * The ledger state behind the seeded row. Defaults to `running-openclaw`, a
     * live ENGINE-owned run, which is the only shape `resume()` may attach.
     *   - `none`: claimed but runless (mid-handoff) — attaching starts an 8-min
     *     watchdog clock nothing refreshes, so it is a guaranteed false `blocked`.
     *   - `running-executor`: a live run owned by the EXECUTOR runner, whose
     *     events the engine never sees — attaching would fail a healthy
     *     heartbeat-governed run at 8 minutes.
     * Both must be SKIPPED. Before this option existed both fakes hardcoded a
     * running `openclaw` exec, so deleting either guard failed nothing.
     */
    exec?: SeedExecState
  }): string
  /** Release any held resource (temp DB). */
  dispose?(): void | Promise<void>
}

export interface CascadeContractHarness {
  /** Build a fresh board (a new temp DB for the real wrapper). Synchronous so the
   *  scenarios keep their `makeHarness()` (no `await`) shape. */
  makeBoard(): CascadeBoard
}

// ─── Fixtures (board-agnostic) ────────────────────────────────────────────────

const KNOWN: KnownAgent[] = [
  { id: 'leader', name: 'Boo Zero' },
  { id: 'a2', name: 'Bug Boo' },
  { id: 'a3', name: 'Design Boo' },
  { id: 'a4', name: 'Test Boo' },
]

const sk = (id: string): string => `agent:${id}:team:t1`
const agentIdForSession = (s: string): string | null => s.match(/^agent:([^:]+):/)?.[1] ?? null

function doneEvent(runId: string, summary: string): RuntimeEvent {
  return { kind: 'done', reason: 'success', summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function failedDoneEvent(
  runId: string,
  reason: 'error' | 'aborted' | 'max_turns',
  summary: string,
): RuntimeEvent {
  return { kind: 'done', reason, summary, runId, sessionId: null, ts: 1, seq: 1 }
}
function errorEvent(runId: string, message: string, fatal: boolean): RuntimeEvent {
  return { kind: 'error', code: null, message, fatal, runId, sessionId: null, ts: 1, seq: 1 }
}
function toolCallEvent(runId: string, name: string, input: unknown): RuntimeEvent {
  return {
    kind: 'tool-call',
    toolCallId: 'tc',
    name,
    input,
    partial: false,
    runId,
    sessionId: null,
    ts: 1,
    seq: 1,
  }
}
function toolResultEvent(runId: string, name: string): RuntimeEvent {
  return {
    kind: 'tool-result',
    toolCallId: 'tc',
    name,
    output: 'ok',
    isError: false,
    runId,
    sessionId: null,
    ts: 1,
    seq: 1,
  }
}

type DelegationResolution = 'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'
interface HarnessOpts {
  stopGen?: () => number
  caps?: { maxFanout?: number }
  onCapHit?: (info: { kind: 'fanout'; sourceTaskId: string | null }) => void
  isRiskyDelegation?: (sig: DelegationSignal) => boolean
  requestDelegationApproval?: (input: {
    leaderAgentId: string
    targetAgentId: string
    targetAgentName: string
    task: string
  }) => Promise<DelegationResolution>
  now?: () => number
  /** Override session resolution (return null to simulate an asleep / unknown agent). */
  sessionKeyForAgent?: (id: string) => string | null
  /** When set, `deliver` rejects for these target agent ids (delivery-failure tests). */
  deliverRejectsFor?: Set<string>
  /** Sessions the HOST reports as having a live run (the server's abortMap). */
  busySessions?: Set<string>
}

type Delivered = { sessionKey: string; agentId: string; task: string }
const reflections = (delivered: Delivered[]): Delivered[] =>
  delivered.filter((d) => d.task.startsWith('[Task Update]'))
const deliveredTo = (
  delivered: Array<{ agentId: string; task: string }>,
  agentId: string,
): string[] => delivered.filter((d) => d.agentId === agentId).map((d) => d.task)
const idsOf = (board: CascadeBoard): string[] => board.created.map((t) => t.id)

/** A task's ledger, asserting the read SUCCEEDED. `listExecutions` returns null
 *  when the ledger cannot be read, which every caller must treat as "unknown"
 *  rather than "empty" — so a contract test that silently accepted null would be
 *  asserting against the wrong thing. Fail loudly here instead. */
const ledgerOf = async (
  board: CascadeBoard,
  taskId: string,
): Promise<Array<{ id: string; status: string; executorType?: string }>> => {
  const execs = await board.listExecutions(taskId)
  expect(execs).not.toBeNull()
  return execs!
}

// ─── The contract ─────────────────────────────────────────────────────────────

/** Register the full cascade-invariant suite against an injected board. Call at the
 *  top level of a consumer test file. */
export function runCascadeContract(harness: CascadeContractHarness): void {
  const openBoards: CascadeBoard[] = []

  function makeHarness(opts?: HarnessOpts): {
    board: CascadeBoard
    delivered: Delivered[]
    changes: BoardChange[]
    narrations: { sessionKey: string; text: string }[]
    aborted: string[]
    orchestrator: ReturnType<typeof createBoardOrchestrator>
  } {
    const board = harness.makeBoard()
    openBoards.push(board)
    const delivered: Delivered[] = []
    const changes: BoardChange[] = []
    const narrations: { sessionKey: string; text: string }[] = []
    const aborted: string[] = []
    const orchestrator = createBoardOrchestrator({
      abortSession: (sessionKey) => aborted.push(sessionKey),
      teamId: 't1',
      board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: opts?.sessionKeyForAgent ?? ((id) => sk(id)),
      agentIdForSession,
      deliver: async (sessionKey, agentId, task) => {
        if (opts?.deliverRejectsFor?.has(agentId)) throw new Error('delivery rejected')
        delivered.push({ sessionKey, agentId, task })
      },
      stopGen: opts?.stopGen ?? (() => 0),
      isSessionBusy: (sessionKey) => opts?.busySessions?.has(sessionKey) ?? false,
      onBoardChange: (c) => changes.push(c),
      narrate: (sessionKey, text) => narrations.push({ sessionKey, text }),
      ...(opts?.caps ? { caps: opts.caps } : {}),
      ...(opts?.onCapHit ? { onCapHit: opts.onCapHit } : {}),
      ...(opts?.isRiskyDelegation ? { isRiskyDelegation: opts.isRiskyDelegation } : {}),
      ...(opts?.requestDelegationApproval
        ? { requestDelegationApproval: opts.requestDelegationApproval }
        : {}),
      ...(opts?.now ? { now: opts.now } : {}),
    })
    return { board, delivered, changes, narrations, aborted, orchestrator }
  }

  // Fake timers gate ONLY the reflection batcher's debounce; the board calls
  // (sync better-sqlite3 under the real client, in-memory for the fake) still
  // resolve when awaited.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const b of openBoards.splice(0)) void b.dispose?.()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  // ─── Governance: orchestrator caps + approval plumbing ────
  describe('createBoardOrchestrator — governance caps + approval', () => {
    const TWO_DELEGATIONS =
      '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>'

    it('caps fan-out per turn (drops the overflow + fires onCapHit)', async () => {
      const capHits: { kind: string }[] = []
      const { board, delivered, orchestrator } = makeHarness({
        caps: { maxFanout: 1 },
        onCapHit: (i) => capHits.push(i),
      })
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', TWO_DELEGATIONS))
      expect(board.taskCount()).toBe(1) // only the first spawned
      expect(delivered).toHaveLength(1)
      expect(capHits).toHaveLength(1)
    })

    it('without caps, fan-out is unbounded', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', TWO_DELEGATIONS))
      expect(board.taskCount()).toBe(2)
    })

    it('a risky delegation DENIED at the approval gate is never created or delivered', async () => {
      const { board, delivered, orchestrator } = makeHarness({
        isRiskyDelegation: () => true,
        requestDelegationApproval: async () => 'deny',
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">delete prod</delegate>'),
      )
      expect(board.taskCount()).toBe(0)
      expect(delivered).toEqual([])
    })

    it('a forgotten approval (timeout / expired) blocks delivery — no deadlock', async () => {
      for (const resolution of ['timeout', 'expired'] as const) {
        const { board, delivered, orchestrator } = makeHarness({
          isRiskyDelegation: () => true,
          requestDelegationApproval: async () => resolution,
        })
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('rX', '<delegate to="@Bug Boo">x</delegate>'),
        )
        expect(board.taskCount()).toBe(0)
        expect(delivered).toEqual([])
      }
    })

    it('an APPROVED risky delegation proceeds normally', async () => {
      const { board, delivered, orchestrator } = makeHarness({
        isRiskyDelegation: () => true,
        requestDelegationApproval: async () => 'allow_once',
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">deploy</delegate>'),
      )
      expect(board.taskCount()).toBe(1)
      expect(delivered).toHaveLength(1)
    })

    it('a NON-risky delegation skips the approval gate entirely', async () => {
      let asked = 0
      const { board, delivered, orchestrator } = makeHarness({
        isRiskyDelegation: () => false,
        requestDelegationApproval: async () => {
          asked += 1
          return 'deny'
        },
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">summarize</delegate>'),
      )
      expect(asked).toBe(0)
      expect(board.taskCount()).toBe(1)
      expect(delivered).toHaveLength(1)
    })
  })

  // ─── derive ─────────────────────────────────────────────────────────────────
  describe('createBoardOrchestrator — derive', () => {
    it('turns a leader delegation into a claimed board task + delivery', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
      )
      expect(board.taskCount()).toBe(1)
      expect(board.claims).toHaveLength(1)
      expect(board.execCount).toBe(1)
      expect(delivered).toEqual([{ sessionKey: sk('a2'), agentId: 'a2', task: 'fix it' }])
    })

    it('drives the full cascade from a `delegate` tool-call (native signal): create → claim → deliver → report-up → [Task Update]', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      // The leader emits a `delegate` TOOL-CALL mid-turn (the native signal), NOT a
      // <delegate> tag — the engine must observe it exactly like sessions_send.
      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r1', 'delegate', { assignee: 'Bug Boo', task: 'fix it' }),
      )
      expect(board.taskCount()).toBe(1)
      expect(board.claims).toHaveLength(1)
      expect(board.execCount).toBe(1)
      expect(delivered).toEqual([{ sessionKey: sk('a2'), agentId: 'a2', task: 'fix it' }])
      // The child completes → status done + a report-up comment.
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Fixed it — patched auth.ts.'))
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'done' })
      expect(board.comments.some((c) => c.taskId === t1 && c.body.includes('Fixed it'))).toBe(true)
      // The result reflects back to the leader (the delegator / reduce-point).
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      expect(refl[0]!.task).toContain('Fixed it')
    })

    it('ignores an unrelated tool-call (only `delegate` / `sessions_send` are delegation signals)', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r1', 'read_file', { path: 'x', assignee: 'Bug Boo', task: 'fix it' }),
      )
      expect(board.taskCount()).toBe(0)
      expect(delivered).toEqual([])
    })

    it('fans out ≥2 structured delegations into N parallel tasks', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
        ),
      )
      expect(board.taskCount()).toBe(2)
      expect(delivered.map((d) => d.agentId).sort()).toEqual(['a2', 'a3'])
    })

    it('does not retry a claim conflict (409) — no execution, no delivery', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      board.forceClaimConflict = true
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">x</delegate>'),
      )
      expect(board.claims).toHaveLength(1)
      expect(board.execCount).toBe(0)
      expect(delivered).toEqual([])
    })

    it(`enforces MAX_SPAWN_DEPTH (${MAX_SPAWN_DEPTH}) via the board ancestor chain`, async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">t1</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">t2</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a3'),
        doneEvent('r3', '<delegate to="@Test Boo">t3</delegate>'),
      )
      await orchestrator.onEvent(sk('a4'), doneEvent('r4', '<delegate to="@Bug Boo">t4</delegate>'))

      expect(board.taskCount()).toBe(3)
      expect(delivered).toHaveLength(3)
      const t3 = idsOf(board)[2]!
      expect(board.comments.some((c) => c.taskId === t3 && /depth limit/i.test(c.body))).toBe(true)
    })

    it(`refuses a whole PLAN from a source already at MAX_SPAWN_DEPTH (${MAX_SPAWN_DEPTH})`, async () => {
      const { board, delivered, orchestrator } = makeHarness()
      // Walk a chain down to the ceiling with immediate delegations.
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">t1</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">t2</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a3'),
        doneEvent('r3', '<delegate to="@Test Boo">t3</delegate>'),
      )
      const beforePlan = board.taskCount()

      // A PLAN from the task now AT the ceiling. startPlan does not go through
      // `spawn`, so without its own preflight every step would be created one level
      // too deep (the repo create it uses is uncapped) and then be undispatchable
      // forever.
      await orchestrator.onEvent(
        sk('a4'),
        doneEvent('r3', '<plan><step to="@Test Boo">s1</step><step to="@Bug Boo">s2</step></plan>'),
      )

      expect(board.taskCount()).toBe(beforePlan) // not one step created
      expect(delivered).toHaveLength(beforePlan)
      const deepest = idsOf(board)[beforePlan - 1]!
      expect(board.comments.some((c) => c.taskId === deepest && /depth limit/i.test(c.body))).toBe(
        true,
      )
    })

    it('dedupes the same delegation seen twice (idempotent re-observation)', async () => {
      const { board, orchestrator } = makeHarness()
      const ev = doneEvent('r1', '<delegate to="@Bug Boo">once</delegate>')
      await orchestrator.onEvent(sk('leader'), ev)
      await orchestrator.onEvent(sk('leader'), ev)
      expect(board.taskCount()).toBe(1)
    })

    it('bails before delivery when the stop generation changes mid-spawn', async () => {
      let gen = 0
      const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
      board.onCreate = () => {
        gen += 1
      }
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">x</delegate>'),
      )
      expect(board.taskCount()).toBe(1)
      expect(delivered).toEqual([])
    })
  })

  // ─── round-trip: completion + report-up ─────────────────────────────────────
  describe('createBoardOrchestrator — round-trip', () => {
    it('marks a task done + records the summary as a report-up comment on child completion', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Fixed it — patched auth.ts.'))
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'done' })
      expect(board.completed).toHaveLength(1)
      expect(board.completed[0]!.outcome.status).toBe('succeeded')
      expect(board.comments.some((c) => c.taskId === t1 && c.body.includes('Fixed it'))).toBe(true)
    })

    it('emits board changes for the projection store (created → claimed → done)', async () => {
      const { changes, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix</delegate>'),
      )
      expect(changes.some((c) => c.status === 'todo')).toBe(true)
      expect(changes.some((c) => c.status === 'in_progress' && c.assigneeAgentId === 'a2')).toBe(
        true,
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'done summary'))
      expect(changes.some((c) => c.status === 'done' && c.summary === 'done summary')).toBe(true)
    })
  })

  // ─── reflect: board → chat ──────────────────────────────────────────────────
  describe('createBoardOrchestrator — reflect', () => {
    it('batches completed tasks into one [Task Update] delivered to the leader', async () => {
      const { delivered, narrations, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
        ),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'A is done'))
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'B is done'))
      expect(reflections(delivered)).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      expect(refl[0]!.agentId).toBe('leader')
      expect(refl[0]!.task).toContain('A is done')
      expect(refl[0]!.task).toContain('B is done')
      expect(
        narrations.some((n) => n.sessionKey === sk('leader') && n.text.startsWith('[Task Update]')),
      ).toBe(true)
    })

    it('a leader done emits no board mutation and no reflection (echo-loop guard)', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(sk('leader'), doneEvent('rL', 'Here is the combined synthesis.'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.statusUpdates).toHaveLength(0)
      expect(reflections(delivered)).toHaveLength(0)
    })
  })

  // ─── failure feedback: the "leader left standing" fix ───────────────────────
  describe('createBoardOrchestrator — failure feedback', () => {
    async function delegate(
      h: ReturnType<typeof makeHarness>,
    ): Promise<ReturnType<typeof makeHarness>> {
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
      )
      return h
    }

    it('an errored child done blocks the task, fails the execution, and reflects a FAILURE to the leader', async () => {
      const { board, delivered, orchestrator } = await delegate(makeHarness())
      await orchestrator.onEvent(
        sk('a2'),
        failedDoneEvent('r2', 'error', 'TypeError: cannot read x'),
      )
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      expect(board.completed).toHaveLength(1)
      expect(board.completed[0]!.outcome.status).toBe('failed')
      expect(board.completed[0]!.outcome.error).toContain('TypeError')
      expect(board.comments.some((c) => c.taskId === t1 && /Run failed/i.test(c.body))).toBe(true)

      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      expect(refl[0]!.task).toMatch(/DID NOT COMPLETE/)
      expect(refl[0]!.task).toContain('TypeError')
      expect(board.completed[0]!.outcome.status).not.toBe('succeeded')
      expect(board.statusUpdates).not.toContainEqual({ taskId: t1, status: 'done' })
    })

    it('a NON-STOP aborted done closes the execution as failed (cancelled = user intent only)', async () => {
      // An abort that reaches failForSession is a wedge/guard kill, not a clean
      // user Stop (those route through releaseClaimed) — it must ledger as
      // infrastructure death so the fire policy keeps the task refireable.
      const { board, orchestrator } = await delegate(makeHarness())
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
      const t1 = idsOf(board)[0]!
      expect(board.completed[0]!.outcome.status).toBe('failed')
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
    })

    it('a fatal error event fails the delegation and reflects it', async () => {
      const { board, delivered, orchestrator } = await delegate(makeHarness())
      await orchestrator.onEvent(sk('a2'), errorEvent('r2', 'gateway exploded', true))
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      expect(board.completed[0]!.outcome.status).toBe('failed')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.task).toMatch(/DID NOT COMPLETE/)
    })

    it('a NON-fatal error keeps waiting — no block, no completion, no reflection', async () => {
      const { board, delivered, orchestrator } = await delegate(makeHarness())
      await orchestrator.onEvent(sk('a2'), errorEvent('r2', 'transient blip', false))
      expect(board.statusUpdates).toHaveLength(0)
      expect(board.completed).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(0)
    })

    it('the watchdog fails a delegate that goes silent past the timeout', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { board, delivered, orchestrator } = h

      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)

      clock += 2
      await orchestrator.sweepStaleSessions()
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      expect(board.completed[0]!.outcome.status).toBe('timed_out')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.task).toMatch(/DID NOT COMPLETE/)
    })

    it('does NOT sweep a delegate that keeps emitting events (activity refreshed)', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { board, orchestrator } = h

      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await orchestrator.onEvent(sk('a2'), toolCallEvent('r2', 'read_file', { path: 'x' }))
      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)
    })

    it('the watchdog ABORTS the zombie run it fails — never just the board row', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { aborted, orchestrator } = h
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      // The failed delegation's live run was killed, not left burning invisibly.
      expect(aborted).toEqual([sk('a2')])
    })

    it('an OPEN tool call earns the longer idle allowance (a silent build is not dead)', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { board, orchestrator } = h

      // The delegate enters one long tool call (a build/test) and goes silent.
      await orchestrator.onEvent(sk('a2'), toolCallEvent('r2', 'run_command', { cmd: 'build' }))
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      // NOT failed at the 8-min window — the call is still open.
      expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)

      // But the allowance is a ceiling, not immunity.
      clock += OPEN_TOOL_CALL_TIMEOUT_MS
      await orchestrator.sweepStaleSessions()
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      expect(board.completed[0]!.outcome.status).toBe('timed_out')
    })

    it('a tool RESULT closes the window — silence after it gets the normal timeout', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { board, orchestrator } = h

      await orchestrator.onEvent(sk('a2'), toolCallEvent('r2', 'run_command', { cmd: 'build' }))
      await orchestrator.onEvent(sk('a2'), toolResultEvent('r2', 'run_command'))
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
    })

    it('a result that lands after the task was released is preserved as a comment', async () => {
      const h = makeHarness()
      await delegate(h)
      const { board, delivered, orchestrator } = h
      const t1 = idsOf(board)[0]!

      // The server stale-sweep releases the task out from under the (still
      // tracked) session — the next `done` must not fake-complete it, but the
      // work itself must survive.
      board.forceRelease(t1)
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Here is the finished patch'))
      expect(board.statusUpdates).not.toContainEqual({ taskId: t1, status: 'done' })
      expect(
        board.comments.some(
          (c) =>
            c.taskId === t1 && /late result/i.test(c.body) && c.body.includes('finished patch'),
        ),
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.task).toMatch(/preserved as a comment/i)
    })

    it('the pump re-fires a sweep-released delegation after an engine restart', async () => {
      const h = makeHarness()
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!
      expect(board.claims.filter((id) => id === t1)).toHaveLength(1)

      // The process died: the sweep timed out the run and released the task
      // (exactly reconcileStaleInProgress's two writes); the engine's memory is
      // gone.
      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'timed_out' })
      board.forceRelease(t1)
      orchestrator.reset()
      // The server dispatch pump rebuilds the engine and pumps it.
      await orchestrator.resume()
      expect(board.claims.filter((id) => id === t1)).toHaveLength(2)
      expect(board.statusOf(t1)).toBe('in_progress')
    })

    it('an out-of-band release DETACHES the session, so a RESIDENT engine can re-fire it', async () => {
      // Every other sweep-release scenario calls `reset()` first, which clears
      // `sessionToTask` and hides this entirely. The real ordering has no reset:
      // the engine is still resident (a user message, or the boot pump waking it)
      // when the sweep releases the task underneath it. `fireTask` then refuses
      // forever on `sessionToTask.has(targetSk)`, the 8-minute watchdog later
      // moves the task to `blocked`, and its dependents are cancelled — a
      // permanent stall caused by the restart, reported as the delegate going
      // silent.
      const h = makeHarness()
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!
      expect(board.claims.filter((id) => id === t1)).toHaveLength(1)
      // The engine is tracking this session RIGHT NOW. That is the precondition.
      expect(orchestrator.taskForSession(sk('a2'))).toBe(t1)

      // The sweep's exact two writes, with the engine still live.
      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'timed_out' })
      board.forceRelease(t1)
      // In production the release publishes `task_released` on the board lifecycle
      // bus and the app-side subscriber makes exactly this call, before pumping
      // (see boardLifecycleSubscribers). The engine has no bus of its own, so the
      // contract states the wiring it depends on explicitly.
      expect(orchestrator.detachTask(t1)).toBe(true)

      await orchestrator.resume()
      expect(board.claims.filter((id) => id === t1)).toHaveLength(2)
      expect(board.statusOf(t1)).toBe('in_progress')
    })

    it('detach REFUSES while a live run still owns the session (no second concurrent run)', async () => {
      // One run per session is load-bearing. If a release detached a session that
      // still has a run streaming on it, the ready-pump would claim the task again
      // and start a SECOND run beside the first. The host answers this from the
      // same map it uses for liveness, so a refusal can never become permanent.
      const busy = new Set([sk('a2')])
      const h = makeHarness({ busySessions: busy })
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!

      board.forceRelease(t1)
      expect(orchestrator.detachTask(t1)).toBe(false)
      await orchestrator.resume()
      expect(board.claims.filter((id) => id === t1)).toHaveLength(1) // no second fire

      // The late terminal still takes the documented late-result path, because the
      // mapping was preserved: the work is recorded, not fake-completed.
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Here is the finished patch'))
      expect(board.statusUpdates).not.toContainEqual({ taskId: t1, status: 'done' })
      expect(board.comments.some((c) => c.taskId === t1 && /late result/i.test(c.body))).toBe(true)
      // The terminal itself then frees the session, so nothing is left pinned:
      // the refusal delays the detach, it does not replace it.
      expect(orchestrator.taskForSession(sk('a2'))).toBeNull()
    })

    it('a released task no longer pins its session, so the watchdog cannot fail it', async () => {
      // The downstream half of the same bug: while the stale mapping survives, the
      // idle watchdog still owns the session and fails a task nobody is running,
      // which cancel-chains every dependent step of the plan.
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!

      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'timed_out' })
      board.forceRelease(t1)
      orchestrator.detachTask(t1)

      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      // Detached ⇒ the watchdog has nothing to fail. Without the detach this is
      // `blocked`, which is terminal for the chain hanging off it.
      expect(board.statusOf(t1)).not.toBe('blocked')
    })

    it('a user-STOPPED delegation is never auto-refired by the pump', async () => {
      const h = makeHarness()
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!

      // The Stop path's durable trace: the exec completes `cancelled`, the task
      // releases to todo (releaseClaimed's exact writes).
      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'cancelled' })
      board.forceRelease(t1)
      orchestrator.reset()
      await orchestrator.resume()
      // The pump saw the cancelled last run and left it alone — a human re-queues.
      expect(board.claims.filter((id) => id === t1)).toHaveLength(1)
      expect(board.statusOf(t1)).toBe('todo')
    })

    it('markStopped makes a Stop durable — tracked AND not-yet-fired work survives a restart stopped', async () => {
      const h = makeHarness()
      const { board, orchestrator } = h
      // Two delegations to one agent: A fires immediately, B defers (serial).
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">task A</delegate><delegate to="@Bug Boo">task B</delegate>',
        ),
      )
      const [tA, tB] = idsOf(board)

      // User hits Stop: the host aborts runs AND calls markStopped. The durable
      // trace must exist NOW — not after the abort terminals land.
      await orchestrator.markStopped()
      const execsA = await ledgerOf(board, tA!)
      expect(execsA[execsA.length - 1]!.status).toBe('cancelled')
      const execsB = await ledgerOf(board, tB!)
      expect(execsB[execsB.length - 1]!.status).toBe('cancelled')

      // Restart (abort terminals never landed): the pump must not refire either.
      board.forceRelease(tA!)
      orchestrator.reset()
      await orchestrator.resume()
      expect(board.claims.filter((id) => id === tA)).toHaveLength(1)
      expect(board.claims.filter((id) => id === tB)).toHaveLength(0)
    })

    it('a permafailing delegation stops being auto-fed at MAX_AUTO_FIRES', async () => {
      const h = makeHarness()
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!

      // Fail-and-release cycles (infra death, not user Stop) until the ledger
      // holds MAX_AUTO_FIRES executions.
      for (;;) {
        const execs = await ledgerOf(board, t1)
        if (execs.length >= MAX_AUTO_FIRES) break
        const last = execs[execs.length - 1]!
        await board.completeExecution(last.id, { status: 'timed_out' })
        board.forceRelease(t1)
        orchestrator.reset()
        await orchestrator.resume()
      }
      const fires = board.claims.filter((id) => id === t1).length
      // One more release cycle: the cap holds, no further fire.
      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'timed_out' })
      board.forceRelease(t1)
      orchestrator.reset()
      await orchestrator.resume()
      expect(board.claims.filter((id) => id === t1)).toHaveLength(fires)
      expect(board.statusOf(t1)).toBe('todo')
    })

    it('onSessionClosed fails a still-in-flight delegation; later calls are no-ops', async () => {
      const { board, orchestrator } = await delegate(makeHarness())
      await orchestrator.onSessionClosed(sk('a2'))
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      const n = board.statusUpdates.length
      await orchestrator.onSessionClosed(sk('a2'))
      expect(board.statusUpdates).toHaveLength(n)
    })

    it('a late completion after a fired timeout is a harmless no-op', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      await delegate(h)
      const { board, orchestrator } = h

      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      const completedCount = board.completed.length

      await orchestrator.onEvent(sk('a2'), doneEvent('rLate', 'oh I finished'))
      expect(board.statusUpdates).not.toContainEqual({ taskId: t1, status: 'done' })
      expect(board.completed).toHaveLength(completedCount)
    })
  })

  // ─── coordination contract: never leave the delegator standing ──────────────
  describe('createBoardOrchestrator — coordination contract', () => {
    it('reflects a failure when the delegation target has no active session', async () => {
      const { board, delivered, orchestrator } = makeHarness({
        sessionKeyForAgent: (id) => (id === 'a3' ? null : sk(id)),
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Design Boo">do it</delegate>'),
      )
      expect(board.taskCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      expect(refl[0]!.task).toMatch(/DID NOT COMPLETE/)
      expect(refl[0]!.task).toMatch(/no active session/i)
    })

    it('reflects an EMPTY completion honestly (no output produced), not a false "completed"', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">write the file</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      // The leader is told the TRUTH (no output), NOT a false "completed" / "deliverable".
      expect(refl[0]!.task).toMatch(/no output/i)
      expect(refl[0]!.task).not.toMatch(/produced a deliverable/i)
      // And the board comment (the card's output) reads honestly, not the task title.
      expect(board.comments.some((c) => /no output produced/i.test(c.body))).toBe(true)
    })

    it('reports a sub-task result to its IMMEDIATE parent (reduce-point), not only the leader', async () => {
      const { delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'top done. <delegate to="@Design Boo">sub task</delegate>'),
      )
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub result here'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      const toA2 = refl.find((r) => r.sessionKey === sk('a2'))
      expect(toA2).toBeTruthy()
      expect(toA2!.task).toContain('sub result here')
      expect(refl.some((r) => r.sessionKey === sk('leader'))).toBe(true)
    })

    it('cancels the dead downstream chain when a plan step fails (no ghost todo)', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'rp',
          '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>',
        ),
      )
      expect(board.taskCount()).toBe(2)
      const [t1, t2] = idsOf(board)
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'error', 'boom'))
      expect(board.statusUpdates).toContainEqual({ taskId: t1!, status: 'blocked' })
      expect(board.statusUpdates).toContainEqual({ taskId: t2!, status: 'cancelled' })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.task).toMatch(/cancelled/i)
    })

    it('nudges the leader once per run when a delegation tag did not parse (loop-safe, but re-nudges a NEW run)', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const malformed = doneEvent('r1', 'On it. <delegate to="@Bug Boo">do the thing (never closed')
      await orchestrator.onEvent(sk('a2'), malformed)
      expect(board.taskCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const first = reflections(delivered)
      expect(first).toHaveLength(1)
      expect(first[0]!.sessionKey).toBe(sk('leader'))
      expect(first[0]!.task).toMatch(/didn't parse|re-issue/i)
      await orchestrator.onEvent(sk('a2'), malformed)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(1)
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'Trying again <delegate to="@Bug Boo">still broken'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(2)
    })

    it('fails the task immediately when delivery is rejected (no 8-minute wait)', async () => {
      const { board, delivered, orchestrator } = makeHarness({ deliverRejectsFor: new Set(['a2']) })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">do it</delegate>'),
      )
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      expect(delivered.filter((d) => d.agentId === 'a2')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.task).toMatch(/DID NOT COMPLETE/)
    })

    it('reflects a fan-out cap overflow to the delegator (work not silently dropped)', async () => {
      const { delivered, orchestrator } = makeHarness({ caps: { maxFanout: 1 } })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
        ),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(
        reflections(delivered).some(
          (r) => r.sessionKey === sk('leader') && /not started|cap/i.test(r.task),
        ),
      ).toBe(true)
    })

    it('a successful completion emits a visible "✓ completed" narration (done ≠ stuck)', async () => {
      const { narrations, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
      expect(narrations.some((n) => /✓.*completed/.test(n.text))).toBe(true)
    })
  })

  // ─── plans: durable deps + auto-unblock ready-pump ──────────────────────────
  describe('createBoardOrchestrator — plans / auto-unblock', () => {
    it('chains plan steps via deps and fires step 2 only after step 1 completes', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'rp',
          '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>',
        ),
      )
      expect(board.taskCount()).toBe(2)
      const [t1, t2] = idsOf(board)
      expect(board.depsOf(t2!)).toEqual([t1!])
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({ agentId: 'a2', task: 's1' })

      await orchestrator.onEvent(sk('a2'), doneEvent('rp2', 'step one done'))
      expect(delivered).toHaveLength(2)
      expect(delivered[1]).toMatchObject({ agentId: 'a3', task: 's2' })
    })
  })

  // ─── coordination hardening (adversarial-review fixes) ──────────────────────
  describe('createBoardOrchestrator — coordination hardening', () => {
    it('serializes two delegations to the SAME agent — both run in order, neither orphaned', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">task A</delegate><delegate to="@Bug Boo">task B</delegate>',
        ),
      )
      expect(board.taskCount()).toBe(2)
      expect(deliveredTo(delivered, 'a2')).toEqual(['task A'])

      await orchestrator.onEvent(sk('a2'), doneEvent('rA', 'A done'))
      // The follow-up for the SAME agent defers one macrotask (the completing
      // drain still holds the agent's home mutex when the pump runs inline).
      await vi.advanceTimersByTimeAsync(1)
      expect(deliveredTo(delivered, 'a2')).toEqual(['task A', 'task B'])

      await orchestrator.onEvent(sk('a2'), doneEvent('rB', 'B done'))
      expect(board.allStatuses().sort()).toEqual(['done', 'done'])
    })

    it('does NOT fake-complete a task released out from under it (server stale-sweep race)', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">long task</delegate>'),
      )
      const t1 = idsOf(board)[0]!
      board.forceRelease(t1)
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'finally done'))
      expect(board.statusOf(t1)).toBe('todo')
      expect(board.statusUpdates).not.toContainEqual({ taskId: t1, status: 'done' })
      expect(board.completed.some((c) => c.outcome.status === 'cancelled')).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(
        reflections(delivered).some((r) => /released\/reassigned|not recorded/i.test(r.task)),
      ).toBe(true)
    })

    it('a user Stop (aborted terminal after stopGen bump) releases the task — no block, no cancel, no failure reflection', async () => {
      let gen = 0
      const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'rp',
          '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>',
        ),
      )
      expect(board.taskCount()).toBe(2)
      const [t1, t2] = idsOf(board)
      gen = 1
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
      expect(board.statusOf(t1!)).toBe('todo')
      expect(board.statusUpdates).not.toContainEqual({ taskId: t1!, status: 'blocked' })
      expect(board.statusOf(t2!)).not.toBe('cancelled')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).some((r) => /DID NOT COMPLETE/.test(r.task))).toBe(false)
    })

    it('a genuine abort (no Stop) still blocks + reflects', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).some((r) => /DID NOT COMPLETE/.test(r.task))).toBe(true)
    })

    it('a late done carrying a <delegate> after a fired timeout does NOT spawn an orphan task', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      const { board, orchestrator } = h
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">task</delegate>'),
      )
      expect(board.taskCount()).toBe(1)
      const t1 = idsOf(board)[0]!
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('rLate', 'Sorry. <delegate to="@Design Boo">orphan</delegate>'),
      )
      expect(board.taskCount()).toBe(1)
    })

    it('refuses to re-delegate after MAX_DELEGATION_FAILURES and tells the leader once', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      for (let i = 0; i < MAX_DELEGATION_FAILURES; i++) {
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent(`r${i}`, '<delegate to="@Bug Boo">flaky task</delegate>'),
        )
        await orchestrator.onEvent(sk('a2'), failedDoneEvent(`rc${i}`, 'error', 'boom'))
      }
      const tasksAfterMax = board.taskCount()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('rFinal', '<delegate to="@Bug Boo">flaky task</delegate>'),
      )
      expect(board.taskCount()).toBe(tasksAfterMax)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(
        reflections(delivered).some((r) =>
          /failed .* times|no longer re-delegating|handle it directly/i.test(r.task),
        ),
      ).toBe(true)
    })

    it('a successful completion RESETS the loop breaker for that (agent, task)', async () => {
      const { board, orchestrator } = makeHarness()
      for (let i = 0; i < 2; i++) {
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent(`rf${i}`, '<delegate to="@Bug Boo">retry me</delegate>'),
        )
        await orchestrator.onEvent(sk('a2'), failedDoneEvent(`rcf${i}`, 'error', 'boom'))
      }
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('rok', '<delegate to="@Bug Boo">retry me</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('rcok', 'done at last'))
      const sizeBefore = board.taskCount()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ragain', '<delegate to="@Bug Boo">retry me</delegate>'),
      )
      expect(board.taskCount()).toBe(sizeBefore + 1)
    })

    it('releases (not ghosts) a plan step when Stop fires between claim and deliver', async () => {
      let gen = 0
      const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'rp',
          '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>',
        ),
      )
      const [, t2] = idsOf(board)
      board.onClaim = () => {
        gen = 1
        board.onClaim = undefined
      }
      await orchestrator.onEvent(sk('a2'), doneEvent('rp2', 's1 done'))
      expect(board.statusOf(t2!)).toBe('todo')
      expect(deliveredTo(delivered, 'a3')).toEqual([])
    })

    it('recovers the reduce-point from the persisted id on resume (mid-chain delegator, not the leader)', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      board.seedInProgress({
        title: 'sub task',
        sourceDelegationId: 'rX:deleg:reflectTo:a2',
        assigneeAgentId: 'a3',
      })
      await orchestrator.resume()
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl.some((r) => r.sessionKey === sk('a2'))).toBe(true)
      expect(refl.some((r) => r.sessionKey === sk('leader'))).toBe(false)
    })

    it('a batched reflection tells the delegator what is STILL outstanding', async () => {
      // Two delegations from one turn, one answer. Without the count the leader
      // cannot tell "both are in" from "one is in and one is still running", so it
      // either waits on finished work or synthesizes a partial answer as complete.
      const h = makeHarness()
      const { board, delivered, orchestrator } = h
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">fix the parser</delegate>' +
            '<delegate to="@Design Boo">draft the empty state</delegate>',
        ),
      )
      expect(idsOf(board)).toHaveLength(2)

      // Only Bug Boo reports.
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'parser fixed'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)

      const refl = reflections(delivered).find((r) => r.sessionKey === sk('leader'))
      expect(refl).toBeDefined()
      expect(refl!.task).toMatch(/Still outstanding: 1/)
      expect(refl!.task).toContain('Design Boo')
    })

    it('says nothing about outstanding work when everything has reported', async () => {
      // The quiet case has to stay quiet: a header line on every single-delegation
      // reflection would be noise on the most common path.
      const h = makeHarness()
      const { delivered, orchestrator } = h
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix it</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)[0]
      expect(refl).toBeDefined()
      expect(refl!.task).not.toMatch(/Still outstanding/)
    })

    it('resume attaches ONLY a live engine-owned run: a runless row is skipped', async () => {
      // Claimed but with no running exec (mid-handoff). Attaching would start an
      // 8-minute watchdog clock nothing can refresh, so the task would be failed
      // to `blocked` for no reason. It must be left alone.
      let clock = 1_000
      const { board, orchestrator } = makeHarness({ now: () => clock })
      const t = board.seedInProgress({
        title: 'claimed but runless',
        sourceDelegationId: 'rX:deleg:reflectTo:leader',
        assigneeAgentId: 'a3',
        exec: 'none',
      })
      await orchestrator.resume()
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      // Never attached ⇒ the watchdog cannot see it ⇒ it is untouched.
      expect(board.statusOf(t)).toBe('in_progress')
      expect(board.statusUpdates.filter((u) => u.taskId === t)).toEqual([])
    })

    it('resume attaches ONLY a live engine-owned run: an EXECUTOR-owned run is skipped', async () => {
      // A running exec the executor runner owns (codex/claude-code/native one-shot).
      // The engine never observes its events, so attaching would falsely fail a
      // perfectly healthy heartbeat-governed run at the 8-minute mark.
      let clock = 1_000
      const { board, orchestrator } = makeHarness({ now: () => clock })
      const t = board.seedInProgress({
        title: 'executor-owned run',
        sourceDelegationId: 'rX:deleg:reflectTo:leader',
        assigneeAgentId: 'a3',
        exec: 'running-executor',
      })
      await orchestrator.resume()
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t)).toBe('in_progress')
      expect(board.statusUpdates.filter((u) => u.taskId === t)).toEqual([])
    })

    it('resume DOES attach an engine-owned run (the guards are not just "skip everything")', async () => {
      // The positive control for the two skips above. Without it, deleting the
      // attach entirely would also make them pass.
      let clock = 1_000
      const { board, orchestrator } = makeHarness({ now: () => clock })
      const t = board.seedInProgress({
        title: 'engine-owned run',
        sourceDelegationId: 'rX:deleg:reflectTo:leader',
        assigneeAgentId: 'a3',
        exec: 'running-openclaw',
      })
      await orchestrator.resume()
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t)).toBe('blocked')
    })
  })
}
