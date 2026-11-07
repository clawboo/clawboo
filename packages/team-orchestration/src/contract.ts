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

import {
  BRAKE_FIRST_WAIT_MS,
  BRAKE_MAX_WAIT_MS,
  encodeHumanAssignment,
  isPlanHolder,
  type ResultClaim,
} from '@clawboo/board-core'
import type { RuntimeEvent } from '@clawboo/executor'

import {
  createBoardOrchestrator,
  DELEGATION_IDLE_TIMEOUT_MS,
  MAX_AUTO_FIRES,
  MAX_DELEGATION_FAILURES,
  MAX_PLAN_STEPS,
  HELD_REPORT_UPS_BUDGET_CHARS,
  MAX_REFUSAL_TURNS,
  MAX_SPAWN_DEPTH,
  OPEN_TOOL_CALL_TIMEOUT_MS,
  PENDING_START_TIMEOUT_MS,
  REFLECT_WINDOW_MS,
  type BoardChange,
  type CapHit,
  type DelegationSignal,
  type KnownAgent,
  type ReportUp,
  type ReportUpOutbox,
  type WorkCheck,
  type WorkCheckResult,
} from './boardOrchestration'
import { BUDGET_HELD_CODE, BUDGET_REFUSED_CODE, DeliveryRefusedError } from './deliveryRefused'
import type { RunStamp, TurnOrigin } from './turnOrigin'
import type { BoardTask, CompleteExecutionOutcome, EngineBoardClient } from './boardClient'

// ─── The board-agnostic inspection + control surface ──────────────────────────
// A superset of `BoardClient` the contract scenarios use. Both the in-memory fake
// and the recording-wrapper over the real client implement it. Inspection is
// synchronous (the fake reads its Map; the real wrapper reads the DB / recorded
// calls); control methods simulate external actors (a stale-sweep release, a
// pre-seeded resumable task) portably across both boards.
export type SeedExecState =
  | 'none'
  | 'running-openclaw'
  | 'running-old-openclaw'
  | 'running-executor'
  | 'running-reported-openclaw'

export interface CascadeBoard extends EngineBoardClient {
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
  /** Turn this team's "ask before a plan starts" switch on or off. */
  setPlanApproval(on: boolean): void
  /** The plans waiting for a person. */
  waitingPlans(): Array<{ questionId: string; taskId: string; steps: string[] }>
  /** A person answers a waiting plan. `created` counts the steps it made. */
  answerPlan(
    questionId: string,
    answer: { accepted: boolean; note?: string },
  ): { ok: boolean; created: number }
  /** Dependency task ids `taskId` waits on (recorded from `linkDep`). */
  depsOf(taskId: string): readonly string[]
  /** Live task count for the team. */
  taskCount(): number
  /** Live statuses of all team tasks (order not guaranteed meaningful). */
  allStatuses(): string[]
  /** Simulate an EXTERNAL release (server stale-sweep): → todo + unassigned, NOT
   *  recorded as an engine status update. */
  forceRelease(taskId: string): void
  /** Make every comment write fail, as a busy database does, or stop doing so. */
  failComments(on: boolean): void
  /** Give the task a stored verdict, as a failed check leaves it. */
  seedVerdict(taskId: string): void
  /** Does the task still hold its stored verdict? */
  hasVerdict(taskId: string): boolean
  /** Simulate the agent's `report_result` on the run its task is on now. */
  seedResultClaim(taskId: string, claim: ResultClaim): void
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
     *   - `running-reported-openclaw`: a live run labelled `openclaw` by someone who is
     *     not the engine. The executions route takes any name.
     * All must be SKIPPED. Before this option existed both fakes hardcoded a
     * running `openclaw` exec, so deleting either guard failed nothing.
     *   - `running-old-openclaw`: an engine run from before the engine marker, which
     *     has only its label. Attached, like `running-openclaw`.
     */
    exec?: SeedExecState
  }): string
  /** Put a job's count where a scenario needs it. Takes any task of the job. `limit`
   *  defaults to `runs`: the job has just reached its limit. */
  seedJobRuns(taskId: string, runs: number, limit?: number): void
  /** Runs this task's job has started by itself. */
  jobRunsOf(taskId: string): number
  /** A person says to carry on. */
  carryOnJobRuns(taskId: string): void
  /** Count a run that has started (the host does it for `TurnOrigin.countJobs`). */
  noteJobRun(taskId: string): void
  /** Mark the job stopped, and read it back: `stopJob` has its own tests with a real outbox. */
  seedJobStopped(taskId: string): void
  jobIsStopped(taskId: string): boolean
  /** Leave a failed check on a task, and read whether it is still there. */
  seedFailedCheck(taskId: string): void
  hasFailedCheck(taskId: string): boolean
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
function errorEvent(
  runId: string,
  message: string,
  fatal: boolean,
  code: string | null = null,
): RuntimeEvent {
  return { kind: 'error', code, message, fatal, runId, sessionId: null, ts: 1, seq: 1 }
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

function statusEvent(runId: string, phase: 'init' | 'running'): RuntimeEvent {
  return { kind: 'status', phase, runId, sessionId: null, ts: 1, seq: 1 }
}
function textEvent(runId: string, text: string): RuntimeEvent {
  return { kind: 'text-delta', text, channel: 'assistant', runId, sessionId: null, ts: 1, seq: 1 }
}

type DelegationResolution = 'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'
interface HarnessOpts {
  stopGen?: () => number
  caps?: { maxFanout?: number }
  onCapHit?: (info: CapHit) => void
  /** Run a second engine over the same board, as the next one after a restart does. */
  board?: CascadeBoard
  /** The durable outbox. Given it, `deliver` takes what the host would put in the run's
   *  context, as the host does at the run's start. */
  reportUps?: ReportUpOutbox
  workCheck?: WorkCheck
  isRiskyDelegation?: (sig: DelegationSignal) => boolean
  requestDelegationApproval?: (input: {
    leaderAgentId: string
    targetAgentId: string
    targetAgentName: string
    task: string
    taskId?: string | null
  }) => Promise<DelegationResolution>
  now?: () => number
  /** Override session resolution (return null to simulate an asleep / unknown agent). */
  sessionKeyForAgent?: (id: string) => string | null
  /** When set, `deliver` rejects for these target agent ids (delivery-failure tests). */
  deliverRejectsFor?: Set<string>
  /** When set, `deliver` refuses these target agent ids with the mapped reason. */
  deliverRefusesFor?: Map<string, string>
  /** When set, `deliver` throws what this returns for a target agent. */
  deliverThrows?: (agentId: string) => Error | null
  /** Sessions the HOST reports as having a live run (the server's abortMap). */
  busySessions?: Set<string>
  /** Sessions with ANY turn in flight or queued (the server's nudge queue). */
  occupiedSessions?: Set<string>
  /** Sessions whose delivery the HOST holds in its run queue (waiting for a slot). */
  queuedSessions?: Set<string>
  /** Awaited by `deliver` before it records the delivery, so a scenario can hold
   *  a delivery pending (a run still waiting on the agent's lock). */
  onDeliverStart?: (agentId: string) => Promise<void> | void
  /** What the host's pause read answers. The claim gate is the board's own, so a scenario
   *  that needs it refused belongs with the real board. */
  runHeldBy?: (run: { agentId: string; taskId: string | null }) => string | null
}

type Delivered = {
  sessionKey: string
  agentId: string
  task: string
  origin: TurnOrigin
  /** What the host would put in the run's context (see `takeHeldReportUps`). */
  context?: string
  reportUpIds?: string[]
}

/** The durable outbox, as the server keeps it, in memory: it outlives each engine. */
export class MemoryReportUps implements ReportUpOutbox {
  private rows = new Map<
    string,
    { item: ReportUp; replays: number; settled: string | null; held: boolean }
  >()
  private n = 0
  /** How many of the next writes fail, as `record` does when the database refuses. */
  failRecords = 0
  /** How many of the next holds fail. */
  failHolds = 0
  record(item: ReportUp, opts: { held?: boolean } = {}): string | null {
    if (this.failRecords > 0) {
      this.failRecords -= 1
      return null
    }
    const id = `ru-${++this.n}`
    this.rows.set(id, { item, replays: 0, settled: null, held: opts.held === true })
    return id
  }
  pending(): Array<{ id: string; item: ReportUp; replays: number }> {
    return [...this.rows]
      .filter(([, r]) => r.settled === null && !r.held)
      .map(([id, r]) => ({ id, item: r.item, replays: r.replays }))
  }
  held(): Array<{ id: string; item: ReportUp }> {
    return [...this.rows]
      .filter(([, r]) => r.settled === null && r.held)
      .map(([id, r]) => ({ id, item: r.item }))
  }
  hold(ids: string[]): boolean {
    if (this.failHolds > 0) {
      this.failHolds -= 1
      return false
    }
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r && r.settled === null) r.held = true
    }
    return true
  }
  /** How a row ended, or null while it has not. */
  settledHow(id: string): string | null {
    return this.rows.get(id)?.settled ?? null
  }
  markReplayed(ids: string[]): boolean {
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r && r.settled === null) r.replays += 1
    }
    return true
  }
  settle(ids: string[], how: string): boolean {
    for (const id of ids) {
      const r = this.rows.get(id)
      if (r && r.settled === null) r.settled = how
    }
    return true
  }
  /** Rows still unsettled for this recipient. */
  unsettledFor(agentId: string): ReportUp[] {
    return [...this.rows.values()]
      .filter((r) => r.settled === null && r.item.toAgentId === agentId)
      .map((r) => r.item)
  }
}

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
): Promise<
  Array<{ id: string; status: string; executorType?: string; errorClass?: string | null }>
> => {
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
    abortedTasks: string[]
    orchestrator: ReturnType<typeof createBoardOrchestrator>
  } {
    const board = opts?.board ?? harness.makeBoard()
    if (!opts?.board) openBoards.push(board)
    const delivered: Delivered[] = []
    const changes: BoardChange[] = []
    const narrations: { sessionKey: string; text: string }[] = []
    const aborted: string[] = []
    const abortedTasks: string[] = []
    const orchestrator = createBoardOrchestrator({
      abortSession: (sessionKey, taskId) => {
        aborted.push(sessionKey)
        abortedTasks.push(taskId)
      },
      teamId: 't1',
      board,
      known: () => KNOWN,
      leaderAgentId: () => 'leader',
      sessionKeyForAgent: opts?.sessionKeyForAgent ?? ((id) => sk(id)),
      agentIdForSession,
      deliver: async (sessionKey, agentId, task, origin) => {
        if (opts?.deliverRejectsFor?.has(agentId)) throw new Error('delivery rejected')
        const refusal = opts?.deliverRefusesFor?.get(agentId)
        if (refusal) throw new DeliveryRefusedError(refusal)
        const thrown = opts?.deliverThrows?.(agentId)
        if (thrown) throw thrown
        await opts?.onDeliverStart?.(agentId)
        const held = opts?.reportUps
          ? orchestrator.takeHeldReportUps(
              sessionKey,
              origin.kind === 'wake' || origin.kind === 'delegation' || origin.kind === 'assignment'
                ? (orchestrator.taskForSession(sessionKey) ?? undefined)
                : undefined,
            )
          : null
        // Its run has started, as far as this host goes.
        if (origin.kind === 'system') for (const id of origin.countJobs ?? []) board.noteJobRun(id)
        delivered.push({
          sessionKey,
          agentId,
          task,
          origin,
          ...(held ? { context: held.text, reportUpIds: held.ids } : {}),
        })
      },
      stopGen: opts?.stopGen ?? (() => 0),
      isSessionBusy: (sessionKey) => opts?.busySessions?.has(sessionKey) ?? false,
      isSessionOccupied: (sessionKey) => opts?.occupiedSessions?.has(sessionKey) ?? false,
      isRunQueued: (sessionKey) => opts?.queuedSessions?.has(sessionKey) ?? false,
      onBoardChange: (c) => changes.push(c),
      narrate: (sessionKey, text) => {
        narrations.push({ sessionKey, text })
      },
      ...(opts?.reportUps ? { reportUps: opts.reportUps } : {}),
      ...(opts?.workCheck ? { workCheck: opts.workCheck } : {}),
      ...(opts?.caps ? { caps: opts.caps } : {}),
      ...(opts?.onCapHit ? { onCapHit: opts.onCapHit } : {}),
      ...(opts?.isRiskyDelegation ? { isRiskyDelegation: opts.isRiskyDelegation } : {}),
      ...(opts?.requestDelegationApproval
        ? { requestDelegationApproval: opts.requestDelegationApproval }
        : {}),
      ...(opts?.now ? { now: opts.now } : {}),
      ...(opts?.runHeldBy ? { runHeldBy: opts.runHeldBy } : {}),
    })
    return { board, delivered, changes, narrations, aborted, abortedTasks, orchestrator }
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

    it('a risky delegation names the task the delegating run works on, if any', async () => {
      const asked: Array<string | null | undefined> = []
      const { board, orchestrator } = makeHarness({
        isRiskyDelegation: () => true,
        requestDelegationApproval: async (input) => {
          asked.push(input.taskId)
          return 'allow_once'
        },
      })
      // A lead's own turn works on no task.
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">deploy it</delegate>'),
      )
      const parent = idsOf(board)[0]!
      // The helper's run works on the task it was handed.
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">deploy the rest</delegate>'),
      )
      expect(asked).toEqual([null, parent])
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
      expect(delivered).toEqual([
        {
          sessionKey: sk('a2'),
          agentId: 'a2',
          task: 'fix it',
          origin: { kind: 'delegation', fromAgentId: 'leader' },
        },
      ])
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
      expect(delivered).toEqual([
        {
          sessionKey: sk('a2'),
          agentId: 'a2',
          task: 'fix it',
          origin: { kind: 'delegation', fromAgentId: 'leader' },
        },
      ])
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
      // To the lead: everyone else handed out a task still open above this one, which
      // the cycle guard refuses first.
      await orchestrator.onEvent(
        sk('a4'),
        doneEvent('r4', '<delegate to="@Boo Zero">t4</delegate>'),
      )

      expect(board.taskCount()).toBe(3)
      expect(delivered.filter((d) => d.origin.kind === 'delegation')).toHaveLength(3)
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
        doneEvent(
          'r3',
          '<plan><step to="@Boo Zero">s1</step><step to="@Boo Zero">s2</step></plan>',
        ),
      )

      expect(board.taskCount()).toBe(beforePlan) // not one step created
      expect(delivered.filter((d) => d.origin.kind === 'delegation')).toHaveLength(beforePlan)
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

    it('stamps WHY each turn is happening, so the host never has to guess', async () => {
      // The host used to work this out from `taskForSession`, which goes stale the
      // instant `completeForSession` forgets the session — so a reflection landing
      // on an agent whose own task had just finished was framed as the team lead's
      // turn, complete with the leader coordination block and the user's intro.
      const { delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
      )
      const task = delivered.find((d) => d.agentId === 'a2')!
      expect(task.origin).toEqual({ kind: 'delegation', fromAgentId: 'leader' })

      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.origin).toMatchObject({ kind: 'system' })
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

    it('never fails a delegation that waits in the host run queue, however long', async () => {
      let clock = 1_000
      const queued = new Set<string>([sk('a2')])
      const h = makeHarness({ now: () => clock, queuedSessions: queued })
      await delegate(h)
      const { board, aborted, orchestrator } = h

      // Far past every allowance, the 24-minute pending-start one included.
      for (let i = 0; i < 6; i++) {
        clock += OPEN_TOOL_CALL_TIMEOUT_MS
        await orchestrator.sweepStaleSessions()
      }
      expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)
      expect(board.completed).toHaveLength(0)
      expect(aborted).toEqual([])
    })

    it('a run that leaves the queue gets the idle window from then, not from the delegation', async () => {
      let clock = 1_000
      const queued = new Set<string>([sk('a2')])
      const h = makeHarness({ now: () => clock, queuedSessions: queued })
      await delegate(h)
      const { board, orchestrator } = h

      clock += OPEN_TOOL_CALL_TIMEOUT_MS
      await orchestrator.sweepStaleSessions()
      // The slot came free and the run started.
      queued.delete(sk('a2'))
      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusUpdates.some((s) => s.status === 'blocked')).toBe(false)

      // From there it is an ordinary run: silence past the window fails it.
      clock += 2
      await orchestrator.sweepStaleSessions()
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
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

    it('a DETACHED session still delegates, detach must not arm the late-replay guard', async () => {
      // Detach is an out-of-band release: the sweep freed the task, but the
      // agent's session is usually STILL ALIVE. `forgetSession` also arms
      // `recentlyTerminated`, and via that path a detach silently dropped every
      // <delegate>/<plan> the live agent emitted for the next 60 seconds: the
      // same silent-loss failure detach exists to prevent. The guard is for run
      // TERMINALS, where a stale summary really can replay.
      const h = makeHarness()
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!
      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'timed_out' })
      board.forceRelease(t1)
      expect(orchestrator.detachTask(t1)).toBe(true)

      // The SAME live session immediately delegates. Before the fix this event
      // hit the recently-terminated early-return and vanished without record.
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r9', '<delegate to="@Design Boo">follow-up work</delegate>'),
      )
      const created = board.created.map((t) => t.title)
      expect(created).toContain('follow-up work')
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
      // The clock moves past the no-progress brake's wait on each cycle, so what
      // stops the fires here is the cap, not the brake.
      let skew = 0
      const h = makeHarness({ now: () => Date.now() + skew })
      await delegate(h)
      const { board, orchestrator } = h
      const t1 = idsOf(board)[0]!

      // Fail-and-release cycles (infra death, not user Stop) until the ledger
      // holds MAX_AUTO_FIRES executions. Bounded: a board that stops firing early
      // fails the assertion below instead of spinning here.
      for (let cycle = 0; cycle < MAX_AUTO_FIRES + 2; cycle++) {
        const execs = await ledgerOf(board, t1)
        if (execs.length >= MAX_AUTO_FIRES) break
        const last = execs[execs.length - 1]!
        await board.completeExecution(last.id, { status: 'timed_out' })
        board.forceRelease(t1)
        orchestrator.reset()
        skew += BRAKE_MAX_WAIT_MS + 1
        await orchestrator.resume()
      }
      expect((await ledgerOf(board, t1)).length).toBe(MAX_AUTO_FIRES)
      const fires = board.claims.filter((id) => id === t1).length
      // One more release cycle: the cap holds, no further fire.
      const execs = await ledgerOf(board, t1)
      await board.completeExecution(execs[execs.length - 1]!.id, { status: 'timed_out' })
      board.forceRelease(t1)
      orchestrator.reset()
      skew += BRAKE_MAX_WAIT_MS + 1
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

    it('an EMPTY completion gets one more turn, then reports no result, never a false "completed"', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">write the file</delegate>'),
      )
      const task = board.created.at(-1)!.id
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
      await vi.advanceTimersByTimeAsync(0)
      expect(board.statusOf(task)).toBe('in_progress')
      expect(reflections(delivered)).toHaveLength(0)
      await orchestrator.onEvent(sk('a2'), doneEvent('r3', ''))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.statusOf(task)).toBe('blocked')
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      // The leader is told the TRUTH, NOT a false "completed" / "deliverable".
      expect(refl[0]!.task).toMatch(/without a result/i)
      expect(refl[0]!.task).not.toMatch(/produced a deliverable/i)
      // And the board comment (the card's output) reads honestly, not the task title.
      expect(board.comments.some((c) => /nothing else to show/i.test(c.body))).toBe(true)
    })

    it('reports a sub-task result to its IMMEDIATE parent (reduce-point), not to the leader', async () => {
      const { delivered, orchestrator } = makeHarness({ reportUps: new MemoryReportUps() })
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
      const toA2 = delivered.filter((d) => d.sessionKey === sk('a2')).at(-1)
      expect(toA2!.context).toContain('sub result here')
      // The leader hears from Bug Boo, when its task is done.
      expect(reflections(delivered).some((r) => r.sessionKey === sk('leader'))).toBe(false)
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

    it('a hand-off nobody could read wakes no one, and rides that agent’s next run', async () => {
      const outbox = new MemoryReportUps()
      const { board, delivered, narrations, orchestrator } = makeHarness({ reportUps: outbox })
      const malformed = doneEvent('r1', 'On it. <delegate to="@Bug Boo">do the thing (never closed')
      await orchestrator.onEvent(sk('a2'), malformed)
      expect(board.taskCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // No turn: a reply answering a note about tags tends to have tags in it.
      expect(delivered).toEqual([])
      expect(narrations.some((n) => /could not be started/.test(n.text))).toBe(true)
      const held = outbox.held()
      expect(held).toHaveLength(1)
      expect(held[0]!.item.toAgentId).toBe('a2')
      // The same run seen again says nothing twice.
      await orchestrator.onEvent(sk('a2'), malformed)
      expect(outbox.held()).toHaveLength(1)
      // A new run that tries again keeps it to one note a run, and starts nothing either.
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'Trying again <delegate to="@Bug Boo">still broken'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(delivered).toEqual([])
      expect(outbox.held()).toHaveLength(2)
      // What the sample showed them is not sent back as a tag to copy.
      const sent = orchestrator.takeHeldReportUps(sk('a2'))!
      expect(sent.text).not.toMatch(/<delegate/)
      expect(sent.text).toMatch(/could not be started/)
    })

    it('ignores a hand-off shown in code or quotes', async () => {
      const outbox = new MemoryReportUps()
      const { board, delivered, narrations, orchestrator } = makeHarness({ reportUps: outbox })
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r1', 'You write it like `<delegate to="@Bug Boo">` and it goes.'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.taskCount()).toBe(0)
      expect(delivered).toEqual([])
      expect(narrations).toEqual([])
      expect(outbox.held()).toEqual([])
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

    it('fails a refused delivery with the reason the host gave, not a generic rejection', async () => {
      const reason = 'The agent budget is paused at its hard cap, so this run did not start.'
      const { board, delivered, orchestrator } = makeHarness({
        deliverRefusesFor: new Map([['a2', reason]]),
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">do it</delegate>'),
      )
      const t1 = idsOf(board)[0]!
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      expect(board.comments.some((c) => c.taskId === t1 && c.body.includes(reason))).toBe(true)
      expect(board.comments.some((c) => /message was rejected/.test(c.body))).toBe(false)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)[0]!.task).toContain(reason)
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
  // ─── steering: a person's message reaches a running delegate ──────────────
  // A steer changes the RUN, never the engine's view of it. A runtime that steers
  // live just keeps streaming; one that stops and resumes (interrupt-and-resume)
  // re-initializes mid-stream, and its driver absorbs the stop so NO terminal
  // reaches the engine for it. Either way the stream the engine sees is a single
  // run: the task stays in progress, mapped to the same session, and ends once.
  describe('createBoardOrchestrator: steered runs', () => {
    async function delegateToBug(h: ReturnType<typeof makeHarness>): Promise<string> {
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">write the launch post</delegate>'),
      )
      return idsOf(h.board)[0]!
    }

    it('a steered run completes its task ONCE: no block, no release, a success reflection', async () => {
      const h = makeHarness()
      const { board, delivered, orchestrator } = h
      const t1 = await delegateToBug(h)

      await orchestrator.onEvent(sk('a2'), toolCallEvent('r2', 'shell', { cmd: 'draft' }))
      // The steer: the stopped process left no terminal; the resumed one re-inits.
      await orchestrator.onEvent(sk('a2'), statusEvent('r2', 'init'))
      expect(board.statusOf(t1)).toBe('in_progress')
      expect(orchestrator.taskForSession(sk('a2'))).toBe(t1)
      await orchestrator.onEvent(sk('a2'), textEvent('r2', 'Short version.'))
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Short version.'))

      expect(board.statusOf(t1)).toBe('done')
      expect(board.statusUpdates.filter((u) => u.taskId === t1).map((u) => u.status)).toEqual([
        'done',
      ])
      expect(board.completed).toHaveLength(1)
      expect(board.completed[0]!.outcome.status).toBe('succeeded')
      expect(board.execCount).toBe(1)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const r = reflections(delivered)
      expect(r).toHaveLength(1)
      expect(r[0]!.task).not.toMatch(/DID NOT COMPLETE/)
    })

    it('a resumed run keeps the idle watchdog off it while it works', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      const t1 = await delegateToBug(h)
      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await h.orchestrator.onEvent(sk('a2'), statusEvent('r2', 'init'))
      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await h.orchestrator.sweepStaleSessions()
      expect(h.board.statusOf(t1)).toBe('in_progress')
      expect(h.aborted).toEqual([])
    })

    it('a steer never shields a run from the person’s Stop: it still releases cleanly', async () => {
      let gen = 0
      const h = makeHarness({ stopGen: () => gen })
      const t1 = await delegateToBug(h)
      await h.orchestrator.onEvent(sk('a2'), statusEvent('r2', 'init'))
      gen = 1
      await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
      expect(h.board.statusOf(t1)).toBe('todo')
      expect(h.board.statusUpdates).not.toContainEqual({ taskId: t1, status: 'blocked' })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered).some((r) => /DID NOT COMPLETE/.test(r.task))).toBe(false)
    })

    it('an abort that DID surface would be a failure, which is why the driver must absorb it', async () => {
      // The guard this whole design leans on: the engine cannot tell a steer's stop
      // from a genuine abort, so a driver that leaked one would block the task.
      const h = makeHarness()
      const t1 = await delegateToBug(h)
      await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'aborted', ''))
      expect(h.board.statusOf(t1)).toBe('blocked')
    })
  })

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

    it('a refused sign-in: the leader is told a person must fix it before any retry', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">write the report</delegate>'),
      )
      const t1 = idsOf(board)[0]!
      await orchestrator.onEvent(
        sk('a2'),
        errorEvent(
          'rc1',
          'Invalid API key · Fix external API key (HTTP 401)',
          true,
          'authentication_failed',
        ),
      )
      expect(board.statusUpdates).toContainEqual({ taskId: t1, status: 'blocked' })
      // The ledger row says why, so the board can offer "Fix sign-in".
      expect(board.completed.at(-1)?.outcome).toMatchObject({
        status: 'failed',
        errorClass: 'Auth',
      })
      expect((await ledgerOf(board, t1)).at(-1)).toMatchObject({ errorClass: 'Auth' })
      expect(
        board.comments.some(
          (c) => c.taskId === t1 && /sign-in/i.test(c.body) && /401/.test(c.body),
        ),
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(
        reflections(delivered).some(
          (r) =>
            r.agentId === 'leader' &&
            /sign-in/i.test(r.task) &&
            /do not re-delegate/i.test(r.task) &&
            /tell the user/i.test(r.task),
        ),
      ).toBe(true)
      // Not blocked in code: once a person fixed the sign-in, "try again" in chat
      // must reach the agent. The ordinary loop breaker still caps repeats.
      const before = board.taskCount()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<delegate to="@Bug Boo">write the report</delegate>'),
      )
      expect(board.taskCount()).toBe(before + 1)
    })

    it('a billing refusal reads as billing; an ordinary error is still worth re-delegating', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">billing task</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        errorEvent('rc1', 'Your credit balance is too low (HTTP 400)', true, 'billing_error'),
      )
      expect(board.completed.at(-1)?.outcome).toMatchObject({ errorClass: 'Billing' })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const billingReports = reflections(delivered).filter((r) => r.agentId === 'leader')
      expect(
        billingReports.some((r) => /billing/i.test(r.task) && /do not re-delegate/i.test(r.task)),
      ).toBe(true)

      // Any other failure gets the plain report in its own batch, and a second try
      // runs. (A provider failure waits and retries first: see honestEndings.test.)
      const seen = delivered.length
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<delegate to="@Test Boo">plain task</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a4'),
        errorEvent('rc2', 'The agent gave up on a bad regex', true, null),
      )
      expect(board.completed.at(-1)?.outcome).toMatchObject({ errorClass: 'Unknown' })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const plainReports = reflections(delivered.slice(seen)).filter((r) => r.agentId === 'leader')
      expect(plainReports.some((r) => /bad regex/.test(r.task))).toBe(true)
      expect(plainReports.some((r) => /do not re-delegate/i.test(r.task))).toBe(false)
      const before = board.taskCount()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r3', '<delegate to="@Test Boo">plain task</delegate>'),
      )
      expect(board.taskCount()).toBe(before + 1)
    })

    it("a failed run's summary is never read as a refused sign-in", async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">add the login route</delegate>'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        failedDoneEvent('rc1', 'error', 'The /login route now returns 401 without a token.'),
      )
      expect(board.completed.at(-1)?.outcome.status).toBe('failed')
      expect(board.completed.at(-1)?.outcome).not.toHaveProperty('errorClass')
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

    it('resume skips a run someone else labelled openclaw: the marker says whose it is', async () => {
      let clock = 1_000
      const { board, orchestrator } = makeHarness({ now: () => clock })
      const t = board.seedInProgress({
        title: 'reported run',
        sourceDelegationId: 'rX:deleg:reflectTo:leader',
        assigneeAgentId: 'a3',
        exec: 'running-reported-openclaw',
      })
      await orchestrator.resume()
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t)).toBe('in_progress')
      expect(board.statusUpdates.filter((u) => u.taskId === t)).toEqual([])
    })

    it('resume attaches an engine run from before the marker, by its label', async () => {
      let clock = 1_000
      const { board, orchestrator } = makeHarness({ now: () => clock })
      const t = board.seedInProgress({
        title: 'old engine run',
        sourceDelegationId: 'rX:deleg:reflectTo:leader',
        assigneeAgentId: 'a3',
        exec: 'running-old-openclaw',
      })
      await orchestrator.resume()
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t)).toBe('blocked')
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
  // ─── A task a person assigned (the board's New task / Retry / Assign) ─────────
  describe('createBoardOrchestrator: person-assigned tasks', () => {
    const assigned = (board: CascadeBoard, agentId: string, title: string, details?: string) =>
      board.createTask({
        title,
        ...(details ? { description: details } : {}),
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment(agentId, `n-${title}`),
      })

    /** Close `count` failed runs on a task, as a crashed or timed-out run would. */
    const failRuns = async (board: CascadeBoard, taskId: string, count: number) => {
      for (let i = 0; i < count; i++) {
        const ex = await board.createExecution(taskId, 'openclaw')
        await board.completeExecution(ex!.id, { status: 'failed', error: 'boom' })
      }
    }

    it('dispatchTask hands the whole brief to the bound agent, framed as the person’s assignment', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await assigned(board, 'a2', 'Draft the launch post', 'Keep it under 200 words.')
      expect(await orchestrator.dispatchTask(task!.id)).toBe('started')
      expect(board.statusOf(task!.id)).toBe('in_progress')
      expect(board.execCount).toBe(1)
      expect(delivered).toEqual([
        {
          sessionKey: sk('a2'),
          agentId: 'a2',
          task: 'Draft the launch post\n\nKeep it under 200 words.',
          origin: { kind: 'assignment' },
        },
      ])
    })

    it('its result is recorded on the task and no agent is told', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await assigned(board, 'a2', 'Draft the launch post')
      await orchestrator.dispatchTask(task!.id)
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Here is the post.'))
      expect(board.statusOf(task!.id)).toBe('done')
      expect(
        board.comments.some((c) => c.taskId === task!.id && c.body.includes('Here is the post.')),
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
    })

    it('its failure lands on blocked with the reason, and no agent is told', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await assigned(board, 'a2', 'Draft the launch post')
      await orchestrator.dispatchTask(task!.id)
      await orchestrator.onEvent(
        sk('a2'),
        failedDoneEvent('r2', 'error', 'provider out of credits'),
      )
      expect(board.statusOf(task!.id)).toBe('blocked')
      expect(
        board.comments.some(
          (c) => c.taskId === task!.id && c.body.includes('provider out of credits'),
        ),
      ).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
    })

    it('the pump fires a person-assigned task on its own, framed the same way', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await assigned(board, 'a3', 'Sketch the empty state')
      await orchestrator.resume()
      expect(board.statusOf(task!.id)).toBe('in_progress')
      expect(delivered.map((d) => d.origin)).toEqual([{ kind: 'assignment' }])
    })

    it('names the open execution of the run a session is doing, and nothing once it ends', async () => {
      const { board, orchestrator } = makeHarness()
      const task = await assigned(board, 'a2', 'Draft the launch post')
      expect(orchestrator.execForSession(sk('a2'))).toBeNull()

      expect(await orchestrator.dispatchTask(task!.id)).toBe('started')
      const ledger = await ledgerOf(board, task!.id)
      expect(ledger).toHaveLength(1)
      expect(orchestrator.execForSession(sk('a2'))).toBe(ledger[0]!.id)
      // A session doing no task has no run execution.
      expect(orchestrator.execForSession(sk('leader'))).toBeNull()

      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Here is the post.'))
      expect(orchestrator.execForSession(sk('a2'))).toBeNull()
    })

    it('a re-fired task names its NEW execution', async () => {
      const { board, orchestrator } = makeHarness()
      const task = await assigned(board, 'a2', 'Draft the launch post')
      await orchestrator.dispatchTask(task!.id)
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'error', 'boom'))
      expect(board.statusOf(task!.id)).toBe('blocked')

      await board.updateStatus(task!.id, 'todo')
      expect(await orchestrator.dispatchTask(task!.id)).toBe('started')

      const ledger = await ledgerOf(board, task!.id)
      expect(ledger).toHaveLength(2)
      expect(orchestrator.execForSession(sk('a2'))).toBe(ledger[1]!.id)
      expect(ledger[1]!.id).not.toBe(ledger[0]!.id)
    })

    it('a person can re-run a task the automatic pump has parked', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await board.createTask({
        title: 'flaky delegation',
        teamId: 't1',
        sourceDelegationId: 'r0:deleg:agent:a3:reflectTo:leader',
      })
      await failRuns(board, task!.id, MAX_AUTO_FIRES)
      await orchestrator.resume()
      expect(delivered).toEqual([]) // parked: the pump leaves it alone
      expect(await orchestrator.dispatchTask(task!.id)).toBe('started')
      // A retried DELEGATION still reports to whoever delegated it.
      expect(delivered).toEqual([
        {
          sessionKey: sk('a3'),
          agentId: 'a3',
          task: 'flaky delegation',
          origin: { kind: 'delegation', fromAgentId: 'leader' },
        },
      ])
    })

    it('a re-run queued behind a busy agent still runs when that agent frees up', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
      )
      const parked = await assigned(board, 'a2', 'Write the release notes')
      await failRuns(board, parked!.id, MAX_AUTO_FIRES)
      expect(await orchestrator.dispatchTask(parked!.id)).toBe('queued')
      expect(deliveredTo(delivered, 'a2')).toEqual(['fix the parser'])

      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'parser fixed'))
      // Same-session follow-ups are deferred one macrotask out of the terminal.
      await vi.advanceTimersByTimeAsync(0)
      expect(board.statusOf(parked!.id)).toBe('in_progress')
      expect(deliveredTo(delivered, 'a2')).toEqual(['fix the parser', 'Write the release notes'])
    })

    it('refuses what it cannot run: no bound agent, not todo, unknown', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const loose = await board.createTask({ title: 'nobody owns me', teamId: 't1' })
      expect(await orchestrator.dispatchTask(loose!.id)).toBe('no_agent')
      const running = await assigned(board, 'a2', 'already running')
      await orchestrator.dispatchTask(running!.id)
      expect(await orchestrator.dispatchTask(running!.id)).toBe('not_ready')
      expect(await orchestrator.dispatchTask('missing')).toBe('not_found')
      expect(deliveredTo(delivered, 'a2')).toEqual(['already running'])
    })

    it('a resumed person-assigned run still reports to no agent', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const t = board.seedInProgress({
        title: 'resumed assignment',
        sourceDelegationId: encodeHumanAssignment('a3', 'n-resume'),
        assigneeAgentId: 'a3',
      })
      await orchestrator.resume()
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'all done'))
      expect(board.statusOf(t)).toBe('done')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
    })

    it('a reflection does not tell the delegator to wait on work the user stopped', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">fix the parser</delegate>' +
            '<delegate to="@Design Boo">draft the empty state</delegate>',
        ),
      )
      const [, design] = idsOf(board)
      // The user stops Design Boo's run: its execution closes `cancelled` and the
      // card is released to todo, where the pump will never touch it again.
      const [run] = await ledgerOf(board, design!)
      await board.completeExecution(run!.id, { status: 'cancelled' })
      board.forceRelease(design!)
      orchestrator.detachTask(design!)

      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'parser fixed'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered).find((r) => r.sessionKey === sk('leader'))
      expect(refl).toBeDefined()
      expect(refl!.task).not.toMatch(/Still outstanding/)
    })
  })
  // ─── An agent busy with a non-task turn (a user reply, a reflection) ──────────
  describe('createBoardOrchestrator: work for an agent mid-turn', () => {
    it('a delegation waits for the reply in flight, and is never completed with it', async () => {
      const occupied = new Set([sk('a2')]) // Bug Boo is answering the user
      const { board, delivered, orchestrator } = makeHarness({ occupiedSessions: occupied })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
      )
      const [t] = idsOf(board)
      expect(board.statusOf(t!)).toBe('todo')
      expect(deliveredTo(delivered, 'a2')).toEqual([])

      // Its reply to the user ends. That reply is NOT the task's output.
      occupied.delete(sk('a2'))
      await orchestrator.onEvent(sk('a2'), doneEvent('rU', 'Here is my answer to you.'))
      await vi.advanceTimersByTimeAsync(0)
      expect(board.comments.some((c) => c.body.includes('Here is my answer'))).toBe(false)
      expect(board.statusOf(t!)).toBe('in_progress')
      expect(deliveredTo(delivered, 'a2')).toEqual(['fix the parser'])

      // And the task's own run is what completes it.
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'parser fixed'))
      expect(board.statusOf(t!)).toBe('done')
      expect(board.comments.some((c) => c.taskId === t && c.body.includes('parser fixed'))).toBe(
        true,
      )
    })

    it('a person’s task for an agent mid-reply is queued, then runs when the reply ends', async () => {
      const occupied = new Set([sk('a2')])
      const { board, delivered, orchestrator } = makeHarness({ occupiedSessions: occupied })
      const task = await board.createTask({
        title: 'Write the release notes',
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment('a2', 'n-busy'),
      })
      expect(await orchestrator.dispatchTask(task!.id)).toBe('queued')
      expect(delivered).toEqual([])

      occupied.delete(sk('a2'))
      await orchestrator.onEvent(sk('a2'), doneEvent('rU', 'chat reply'))
      await vi.advanceTimersByTimeAsync(0)
      expect(board.statusOf(task!.id)).toBe('in_progress')
      expect(delivered.map((d) => [d.agentId, d.task, d.origin])).toEqual([
        ['a2', 'Write the release notes', { kind: 'assignment' }],
      ])
    })
  })
  // ─── Results that come back on a closed task, and runs still waiting to start ─
  describe('createBoardOrchestrator: follow-ups and pending deliveries', () => {
    const stamp = (reportForTaskId: string | null, stopGen = 0): RunStamp => ({
      reportForTaskId,
      stopGen,
    })
    const commentsOn = (board: CascadeBoard, taskId: string): string[] =>
      board.comments.filter((c) => c.taskId === taskId).map((c) => c.body)

    /** A task waiting on its sub-tasks closes all the same: someone decided it. */
    async function closeWaiting(board: CascadeBoard, taskId: string): Promise<void> {
      expect(board.statusOf(taskId)).toBe('blocked')
      await board.updateStatus(taskId, 'in_progress')
      await board.updateStatus(taskId, 'done')
    }

    /** The leader hands Bug Boo 'top task', and Bug Boo's done hands Design Boo a
     *  sub-task. Someone decides the top task while it waits, and the sub-task then
     *  reports on a closed task. Returns the top task's id. */
    async function subTaskUnderClosedTask(h: ReturnType<typeof makeHarness>): Promise<string> {
      const { board, orchestrator } = h
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      const [top] = idsOf(board)
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'top done. <delegate to="@Design Boo">sub task</delegate>'),
      )
      await closeWaiting(board, top!)
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub result here'))
      return top!
    }

    it('a sub-task under a finished task reports to its delegator as a follow-up', async () => {
      const h = makeHarness()
      const top = await subTaskUnderClosedTask(h)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(h.delivered)
      const toA2 = refl.find((r) => r.sessionKey === sk('a2'))!
      expect(toA2.origin).toMatchObject({ kind: 'system', forTaskId: top })
      expect(toA2.task).toMatch(/not shown to the user/)
      expect(toA2.task).toContain('"top task"')
    })

    it('the follow-up reply is recorded on the closed task and passed to its delegator', async () => {
      const h = makeHarness()
      const { board, delivered, orchestrator } = h
      const top = await subTaskUnderClosedTask(h)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const updatesForTop = board.statusUpdates.filter((u) => u.taskId === top).length
      const tasks = board.taskCount()

      await orchestrator.onEvent(sk('a2'), doneEvent('rF', 'combined: top + sub'), stamp(top))
      expect(commentsOn(board, top).some((b) => b.includes('combined: top + sub'))).toBe(true)
      // A follow-up is not a task run: the closed task stays closed, nothing new
      // is created, and the session is not bound to anything.
      expect(board.statusUpdates.filter((u) => u.taskId === top)).toHaveLength(updatesForTop)
      expect(board.taskCount()).toBe(tasks)
      expect(orchestrator.taskForSession(sk('a2'))).toBeNull()

      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLeader = reflections(delivered).find(
        (r) => r.sessionKey === sk('leader') && r.task.includes('combined: top + sub'),
      )
      expect(toLeader).toBeDefined()
      expect(toLeader!.origin).toMatchObject({ kind: 'system' })
    })

    it('work a follow-up delegates is parented under the task it follows up on', async () => {
      // Bug Boo's session is inside the late-replay window (its task run just
      // ended), which drops a delegation from an unparented terminal.
      const h = makeHarness()
      const { board, orchestrator } = h
      const top = await subTaskUnderClosedTask(h)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('rF', 'needs more. <delegate to="@Test Boo">more checks</delegate>'),
        stamp(top),
      )
      const more = board.created.find((t) => t.title === 'more checks')
      expect(more).toBeDefined()
      expect((await board.getTask(more!.id))!.ancestors.map((a) => a.id)).toContain(top)
    })

    it('a person-assigned task keeps its follow-up on its card', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await board.createTask({
        title: 'Ship the launch post',
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment('a2', 'n-launch'),
      })
      expect(await orchestrator.dispatchTask(task!.id)).toBe('started')
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'drafted. <delegate to="@Design Boo">make the banner</delegate>'),
      )
      await closeWaiting(board, task!.id)
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'banner made'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toA2 = reflections(delivered).filter((r) => r.sessionKey === sk('a2'))
      expect(toA2).toHaveLength(1)
      expect(toA2[0]!.origin).toMatchObject({ kind: 'system', forTaskId: task!.id })

      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('rF', 'post and banner ready'),
        stamp(task!.id),
      )
      expect(commentsOn(board, task!.id).some((b) => b.includes('post and banner ready'))).toBe(
        true,
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // The person reads it on the card: no agent is told.
      expect(reflections(delivered).map((r) => r.sessionKey)).toEqual([sk('a2')])
    })

    it('after a Stop a follow-up still lands on the card, and nothing new is started', async () => {
      let gen = 0
      const h = makeHarness({ stopGen: () => gen })
      const { board, delivered, orchestrator } = h
      const top = await subTaskUnderClosedTask(h)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const before = reflections(delivered).length

      gen = 1
      await orchestrator.onEvent(sk('a2'), doneEvent('rF', 'combined after stop'), stamp(top, 0))
      expect(commentsOn(board, top).some((b) => b.includes('combined after stop'))).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(before)
    })

    it('a follow-up the user stopped is a pause: no comment, no reflection', async () => {
      let gen = 0
      const h = makeHarness({ stopGen: () => gen })
      const { board, delivered, orchestrator } = h
      const top = await subTaskUnderClosedTask(h)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const before = reflections(delivered).length
      const comments = commentsOn(board, top).length

      gen = 1
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('rF', 'aborted', ''), stamp(top, 0))
      expect(commentsOn(board, top)).toHaveLength(comments)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(before)
    })

    it('a failed follow-up is recorded on the task and its delegator is told', async () => {
      const h = makeHarness()
      const { board, delivered, orchestrator } = h
      const top = await subTaskUnderClosedTask(h)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const before = reflections(delivered).length

      await orchestrator.onEvent(
        sk('a2'),
        failedDoneEvent('r4', 'error', 'provider down'),
        stamp(top),
      )
      const failed = commentsOn(board, top).find((b) => /Follow-up did not finish/.test(b))
      expect(failed).toContain('provider down')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const fresh = reflections(delivered).slice(before)
      expect(fresh.find((r) => r.sessionKey === sk('leader'))?.task).toMatch(/DID NOT COMPLETE/)

      await orchestrator.onSessionClosed(sk('a2'), stamp(top))
      expect(commentsOn(board, top).some((b) => /ended before reporting/.test(b))).toBe(true)
    })

    it('a refusal of work delegated from a running task comes back in its follow-up', async () => {
      const { board, delivered, orchestrator } = makeHarness({
        caps: { maxFanout: 1 },
        reportUps: new MemoryReportUps(),
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      const [top] = idsOf(board)
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent(
          'r2',
          'top done. <delegate to="@Design Boo">b</delegate><delegate to="@Test Boo">c</delegate>',
        ),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.statusOf(top!)).toBe('blocked')
      expect(reflections(delivered).filter((r) => r.sessionKey === sk('a2'))).toEqual([])
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'b is done'))
      await vi.advanceTimersByTimeAsync(0)
      const turn = delivered.filter((d) => d.sessionKey === sk('a2')).at(-1)!
      expect(turn.origin).toMatchObject({ kind: 'wake', reason: 'subtasks_closed' })
      expect(turn.context).toMatch(/Fan-out cap/)
    })

    it('an @mentioned specialist that delegates gets a plain update back', async () => {
      const { delivered, orchestrator } = makeHarness()
      // No task: a person asked Bug Boo directly, and it handed part of it off.
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('rM', 'on it. <delegate to="@Design Boo">sketch it</delegate>'),
      )
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sketched'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toA2 = reflections(delivered).find((r) => r.sessionKey === sk('a2'))!
      expect(toA2.origin).toMatchObject({ kind: 'system' })
      expect(toA2.origin).not.toHaveProperty('forTaskId')
    })

    it('a result on a closed task reaches the team lead as a plain update, for the chat', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const task = await board.createTask({
        title: 'Plan the launch',
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment('leader', 'n-lead'),
      })
      expect(await orchestrator.dispatchTask(task!.id)).toBe('started')
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', 'planned. <delegate to="@Design Boo">make the banner</delegate>'),
      )
      await closeWaiting(board, task!.id)
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'banner made'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLeader = reflections(delivered).find((r) => r.sessionKey === sk('leader'))!
      expect(toLeader.origin).toMatchObject({ kind: 'system' })
      expect(toLeader.origin).not.toHaveProperty('forTaskId')
    })

    it('a pump-fired sub-task still reports to its mid-chain delegator after an engine rebuild', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      // Durable state only: Bug Boo finished 'top task', and the sub-task it
      // delegated is still waiting to run. The engine has no memory of either.
      const top = (await board.createTask({
        title: 'top task',
        teamId: 't1',
        sourceDelegationId: 'r0:deleg:agent:a2:reflectTo:leader',
      }))!.id
      expect((await board.claim(top, 'a2', 'openclaw')).ok).toBe(true)
      expect(await board.updateStatus(top, 'done')).toBe(true)
      await board.createTask({
        title: 'sub task',
        teamId: 't1',
        parentTaskId: top,
        sourceDelegationId: 'r1:deleg:agent:a3:reflectTo:a2',
      })

      await orchestrator.resume()
      expect(deliveredTo(delivered, 'a3')).toEqual(['sub task'])
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('a2'))
      expect(refl[0]!.origin).toMatchObject({ kind: 'system', forTaskId: top })
    })

    /** Holds the first delivery to `agentId` until `release()`, as a run waiting
     *  on the agent's lock would. `reached` resolves once it is waiting. */
    function holdDelivery(agentId: string): {
      reached: Promise<void>
      release: () => void
      onDeliverStart: (id: string) => Promise<void> | void
    } {
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let arrive!: () => void
      const reached = new Promise<void>((r) => (arrive = r))
      let armed = true
      const onDeliverStart = (id: string): Promise<void> | void => {
        if (id !== agentId || !armed) return
        armed = false
        arrive()
        return held
      }
      return { reached, release, onDeliverStart }
    }
    const DELEGATE_TOP = doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>')

    it('the watchdog does not count time a delivery spends waiting to start', async () => {
      let clock = 1_000
      const hold = holdDelivery('a2')
      const { board, aborted, orchestrator } = makeHarness({
        now: () => clock,
        onDeliverStart: hold.onDeliverStart,
      })
      const pending = orchestrator.onEvent(sk('leader'), DELEGATE_TOP)
      await hold.reached
      const [t] = idsOf(board)

      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t!)).toBe('in_progress')
      expect(aborted).toEqual([])

      // The allowance is a ceiling, not immunity.
      clock += PENDING_START_TIMEOUT_MS
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t!)).toBe('blocked')
      expect(commentsOn(board, t!).some((b) => /did not start within 24 minutes/.test(b))).toBe(
        true,
      )
      hold.release()
      await pending
    })

    it('the idle window restarts when the run starts', async () => {
      let clock = 1_000
      const hold = holdDelivery('a2')
      const { board, orchestrator } = makeHarness({
        now: () => clock,
        onDeliverStart: hold.onDeliverStart,
      })
      const pending = orchestrator.onEvent(sk('leader'), DELEGATE_TOP)
      await hold.reached
      const [t] = idsOf(board)
      clock += 9 * 60_000
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t!)).toBe('in_progress')

      hold.release()
      await pending
      clock += DELEGATION_IDLE_TIMEOUT_MS - 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t!)).toBe('in_progress')
      clock += 2
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t!)).toBe('blocked')
    })

    it('a Stop while a delivery waits to start releases the task, with no watchdog left behind', async () => {
      // The host refuses a start the user stopped, so no terminal will ever come
      // back for this run. The engine must free the task itself.
      let clock = 1_000
      let gen = 0
      const hold = holdDelivery('a2')
      const { board, delivered, orchestrator } = makeHarness({
        now: () => clock,
        stopGen: () => gen,
        onDeliverStart: hold.onDeliverStart,
      })
      const pending = orchestrator.onEvent(sk('leader'), DELEGATE_TOP)
      await hold.reached
      const [t] = idsOf(board)
      gen = 1
      await orchestrator.markStopped()
      hold.release()
      await pending
      expect(board.statusOf(t!)).toBe('todo')
      expect(orchestrator.taskForSession(sk('a2'))).toBeNull()

      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(t!)).toBe('todo')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
    })

    it('a run delivered before a Stop starts no new work after it', async () => {
      const gen = 1 // the user has pressed Stop once
      const { board, orchestrator } = makeHarness({ stopGen: () => gen })
      const spawnX = (runId: string) => doneEvent(runId, '<delegate to="@Bug Boo">x</delegate>')
      await orchestrator.onEvent(sk('leader'), spawnX('r1'), stamp(null, 0))
      expect(board.taskCount()).toBe(0)
      // The positive control: a run delivered after the Stop still delegates.
      await orchestrator.onEvent(sk('leader'), spawnX('r2'), stamp(null, gen))
      expect(board.taskCount()).toBe(1)
    })

    /** A person assigns Bug Boo a task and it is dispatched with its delivery
     *  held. Resolves once the delivery is waiting to start. */
    async function heldDispatch(
      h: ReturnType<typeof makeHarness>,
      hold: ReturnType<typeof holdDelivery>,
    ): Promise<{ id: string; pending: Promise<unknown> }> {
      const task = await h.board.createTask({
        title: 'Ship the launch post',
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment('a2', 'n-held'),
      })
      const pending = h.orchestrator.dispatchTask(task!.id)
      await hold.reached
      return { id: task!.id, pending }
    }

    it('a Stop while a dispatched task waits to start releases it too', async () => {
      let gen = 0
      const hold = holdDelivery('a2')
      const h = makeHarness({ stopGen: () => gen, onDeliverStart: hold.onDeliverStart })
      const { id, pending } = await heldDispatch(h, hold)
      gen = 1
      await h.orchestrator.markStopped()
      hold.release()
      await pending
      expect(h.board.statusOf(id)).toBe('todo')
      expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()
    })

    it('the watchdog does not count time a dispatched task waits to start', async () => {
      let clock = 1_000
      const hold = holdDelivery('a2')
      const h = makeHarness({ now: () => clock, onDeliverStart: hold.onDeliverStart })
      const { id, pending } = await heldDispatch(h, hold)
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await h.orchestrator.sweepStaleSessions()
      expect(h.board.statusOf(id)).toBe('in_progress')
      expect(h.aborted).toEqual([])
      hold.release()
      await pending
    })

    /** The leader hands Bug Boo 'top task', and Bug Boo's done carries `body`. If that
     *  handed out work, someone decides the task while it waits. Either way it is closed
     *  when this returns. Returns the top task's id. */
    async function closeTopWith(h: ReturnType<typeof makeHarness>, body: string): Promise<string> {
      await h.orchestrator.onEvent(sk('leader'), DELEGATE_TOP)
      const [top] = idsOf(h.board)
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', `top done. ${body}`))
      if (h.board.statusOf(top!) === 'blocked') await closeWaiting(h.board, top!)
      expect(h.board.statusOf(top!)).toBe('done')
      return top!
    }
    const followUpTo = (delivered: Delivered[], agentId: string, said: RegExp): TurnOrigin =>
      reflections(delivered).find((r) => r.sessionKey === sk(agentId) && said.test(r.task))!.origin

    it('a sub-task that fails under a finished task reports to its delegator as a follow-up', async () => {
      const h = makeHarness()
      const top = await closeTopWith(h, '<delegate to="@Design Boo">sub task</delegate>')
      await h.orchestrator.onEvent(sk('a3'), failedDoneEvent('r3', 'error', 'boom'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(h.delivered, 'a2', /boom/)).toMatchObject({
        kind: 'system',
        forTaskId: top,
      })
    })

    it('a sub-task that times out under a finished task reports to its delegator as a follow-up', async () => {
      let clock = 1_000
      const h = makeHarness({ now: () => clock })
      const top = await closeTopWith(h, '<delegate to="@Design Boo">sub task</delegate>')
      clock += DELEGATION_IDLE_TIMEOUT_MS + 1
      await h.orchestrator.sweepStaleSessions()
      expect(h.aborted).toEqual([sk('a3')])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toA2 = reflections(h.delivered).filter((r) => r.sessionKey === sk('a2'))
      expect(toA2.map((r) => r.origin)).toMatchObject([{ kind: 'system', forTaskId: top }])
    })

    /** Three levels, each task closed before the next reports: Bug Boo hands
     *  Design Boo 'mid task' from 'top task', and Design Boo hands Test Boo
     *  'leaf task' from it, which reports. */
    async function chainOfThree(
      h: ReturnType<typeof makeHarness>,
    ): Promise<{ top: string; mid: string }> {
      const top = await closeTopWith(h, '<delegate to="@Design Boo">mid task</delegate>')
      const mid = h.board.created.find((t) => t.title === 'mid task')!.id
      await h.orchestrator.onEvent(
        sk('a3'),
        doneEvent('r3', 'mid done. <delegate to="@Test Boo">leaf task</delegate>'),
      )
      await closeWaiting(h.board, mid)
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'leaf result'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      return { top, mid }
    }

    it('a follow-up climbs a chain of delegators until it reaches the lead', async () => {
      const h = makeHarness()
      const { top, mid } = await chainOfThree(h)
      expect(followUpTo(h.delivered, 'a3', /leaf result/)).toMatchObject({
        kind: 'system',
        forTaskId: mid,
      })

      await h.orchestrator.onEvent(sk('a3'), doneEvent('rF3', 'mid plus leaf'), stamp(mid))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(h.delivered, 'a2', /mid plus leaf/)).toMatchObject({
        kind: 'system',
        forTaskId: top,
      })

      await h.orchestrator.onEvent(sk('a2'), doneEvent('rF2', 'all three levels'), stamp(top))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLead = followUpTo(h.delivered, 'leader', /all three levels/)
      expect(toLead).toMatchObject({ kind: 'system' })
      expect(toLead).not.toHaveProperty('forTaskId')
    })

    it('a failed follow-up mid-chain still reaches its delegator as a follow-up', async () => {
      const h = makeHarness()
      const { top, mid } = await chainOfThree(h)
      await h.orchestrator.onEvent(
        sk('a3'),
        failedDoneEvent('rF3', 'error', 'provider down'),
        stamp(mid),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(h.delivered, 'a2', /provider down/)).toMatchObject({
        kind: 'system',
        forTaskId: top,
      })
    })

    it('work handed from a finished task to an agent with no session comes back as a follow-up', async () => {
      for (const [body, said] of [
        ['<delegate to="@Design Boo">sub task</delegate>', /no active session/],
        [
          '<plan><step to="@Design Boo">s1</step><step to="@Test Boo">s2</step></plan>',
          /Plan step skipped/,
        ],
      ] as const) {
        const h = makeHarness({ sessionKeyForAgent: (id) => (id === 'a3' ? null : sk(id)) })
        const top = await closeTopWith(h, body)
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(followUpTo(h.delivered, 'a2', said)).toMatchObject({
          kind: 'system',
          forTaskId: top,
        })
      }
    })

    it('a plan step whose agent went offline, under a finished task, comes back as a follow-up', async () => {
      const offline = new Set<string>()
      const h = makeHarness({ sessionKeyForAgent: (id) => (offline.has(id) ? null : sk(id)) })
      const top = await closeTopWith(
        h,
        '<plan><step to="@Design Boo">s1</step><step to="@Test Boo">s2</step></plan>',
      )
      offline.add('a4')
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 's1 done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(h.delivered, 'a2', /could not be delivered/)).toMatchObject({
        kind: 'system',
        forTaskId: top,
      })
    })

    it('a plan step the board could not create, from a finished task, comes back as a follow-up', async () => {
      const h = makeHarness()
      const create = h.board.createHandOff.bind(h.board)
      h.board.createHandOff = async (input) =>
        input.title === 's1' ? { ok: false, reason: 'error' } : create(input)
      const top = await closeTopWith(h, '<plan><step to="@Design Boo">s1</step></plan>')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(h.delivered, 'a2', /Could not create the board task/)).toMatchObject({
        kind: 'system',
        forTaskId: top,
      })
    })

    it('a plan refused at the depth limit from a finished task comes back as a follow-up', async () => {
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
      const t3 = idsOf(board)[2]!
      await orchestrator.onEvent(
        sk('a4'),
        doneEvent(
          'r4',
          '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>',
        ),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(delivered, 'a4', /Plan not started/)).toMatchObject({
        kind: 'system',
        forTaskId: t3,
      })
    })

    it('a late result for a sub-task under a finished task comes back as a follow-up', async () => {
      const h = makeHarness()
      const top = await closeTopWith(h, '<delegate to="@Design Boo">sub task</delegate>')
      h.board.forceRelease(h.board.created.find((t) => t.title === 'sub task')!.id)
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub result here'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUpTo(h.delivered, 'a2', /arrived after the task was released/)).toMatchObject({
        kind: 'system',
        forTaskId: top,
      })
    })
  })

  // ─── A task that hands out work waits for it ────
  // A run that ended well with work still out does not close its task: the task waits,
  // its agent gets one follow-up turn when all of it has closed, and it is done after
  // that turn. "All closed" comes from the board and the durable report-up rows, so a
  // restart between two sub-tasks neither starts the turn early nor loses it.
  describe('createBoardOrchestrator: a task that hands out work waits for it', () => {
    type Harness = ReturnType<typeof makeHarness>
    const followUps = (h: Harness, agentId: string): Delivered[] =>
      h.delivered.filter((d) => d.agentId === agentId && d.origin.kind === 'wake')
    const stampOf = (d: Delivered, execId?: string): RunStamp => ({
      reportForTaskId: null,
      stopGen: 0,
      ...(d.reportUpIds?.length ? { reportUpIds: d.reportUpIds } : {}),
      ...(execId ? { execId } : {}),
    })
    const statusOf = (h: Harness, id: string): string | undefined => h.board.statusOf(id)
    const openRuns = async (h: Harness, id: string): Promise<number> =>
      (await ledgerOf(h.board, id)).filter((e) => e.status === 'running').length

    /** The leader hands Bug Boo 'top task', which hands out two sub-tasks and ends well. */
    async function parentWithTwo(opts?: HarnessOpts): Promise<{
      h: Harness
      top: string
      a: string
      b: string
    }> {
      const h = makeHarness({ reportUps: new MemoryReportUps(), ...opts })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      const [top] = idsOf(h.board)
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent(
          'r2',
          'split it. <delegate to="@Design Boo">part a</delegate><delegate to="@Test Boo">part b</delegate>',
        ),
      )
      const a = h.board.created.find((t) => t.title === 'part a')!.id
      const b = h.board.created.find((t) => t.title === 'part b')!.id
      return { h, top: top!, a, b }
    }

    it('a parent with open sub-tasks is not done, and its run closes as the success it was', async () => {
      const { h, top } = await parentWithTwo()
      expect(statusOf(h, top)).toBe('blocked')
      expect((await h.board.getTask(top))!.task['waitingOn']).toContain('subtasks')
      expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()
      expect(await openRuns(h, top)).toBe(0)
      expect(h.board.comments.some((c) => c.taskId === top && c.body.includes('split it'))).toBe(
        true,
      )
      // Whoever handed it out is not woken for this: the task is still outstanding.
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toHaveLength(0)
    })

    it('one sub-task in starts nothing, however long the batch window runs', async () => {
      const { h, top } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 3)
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(statusOf(h, top)).toBe('blocked')
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
    })

    it('the last one in starts one follow-up, and the parent is done after that turn', async () => {
      const { h, top } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(0)
      const turns = followUps(h, 'a2')
      expect(turns).toHaveLength(1)
      expect(turns[0]!.origin).toMatchObject({ kind: 'wake', reason: 'subtasks_closed' })
      expect(turns[0]!.context).toContain('a result')
      expect(turns[0]!.context).toContain('b result')
      expect(statusOf(h, top)).toBe('in_progress')
      expect(h.orchestrator.taskForSession(sk('a2'))).toBe(top)

      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r5', 'both parts are in and fit together'),
        stampOf(turns[0]!),
      )
      expect(statusOf(h, top)).toBe('done')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // The delegator hears once, with the follow-up's result, and no sub-task of it.
      const toLeader = reflections(h.delivered).filter((r) => r.agentId === 'leader')
      expect(toLeader).toHaveLength(1)
      expect(toLeader[0]!.task).toContain('both parts are in and fit together')
      expect(followUps(h, 'a2')).toHaveLength(1)
    })

    it('settles the report-ups the follow-up carried, and sends none of them again', async () => {
      const outbox = new MemoryReportUps()
      const { h } = await parentWithTwo({ reportUps: outbox })
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'all in'), stampOf(turn!))
      expect(outbox.unsettledFor('a2')).toHaveLength(0)
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(h.delivered.filter((d) => d.agentId === 'a2' && /a result/.test(d.task))).toEqual([])
    })

    it('two sub-tasks finishing together start one follow-up', async () => {
      const { h } = await parentWithTwo()
      await Promise.all([
        h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result')),
        h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result')),
      ])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(followUps(h, 'a2')).toHaveLength(1)
    })

    it('a restart between two sub-tasks does not start the follow-up early', async () => {
      const outbox = new MemoryReportUps()
      const { h, top } = await parentWithTwo({ reportUps: outbox })
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      h.orchestrator.reset()

      const next = makeHarness({ board: h.board, reportUps: outbox })
      await next.orchestrator.resume()
      await next.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(statusOf(next, top)).toBe('blocked')
      expect(next.delivered.filter((d) => d.agentId === 'a2')).toEqual([])
    })

    it('a restart between two sub-tasks does not lose the first one’s report', async () => {
      const outbox = new MemoryReportUps()
      const { h, top } = await parentWithTwo({ reportUps: outbox })
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      h.orchestrator.reset()

      const next = makeHarness({ board: h.board, reportUps: outbox })
      await next.orchestrator.resume()
      await next.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const turns = followUps(next, 'a2')
      expect(turns).toHaveLength(1)
      expect(turns[0]!.context).toContain('a result')
      expect(turns[0]!.context).toContain('b result')

      await next.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'all in'), stampOf(turns[0]!))
      expect(statusOf(next, top)).toBe('done')
    })

    it('a restart after the last sub-task closed still runs the follow-up, once', async () => {
      const outbox = new MemoryReportUps()
      const { h } = await parentWithTwo({ reportUps: outbox })
      // The process dies right after the last sub-task's write, before any follow-up.
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      const deliver = h.delivered.length
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(0)
      expect(h.delivered.length).toBeGreaterThan(deliver)
      h.orchestrator.reset()
      // The run it started died with the process: the board's sweep puts it back.
      const top = h.board.created[0]!.id
      for (const e of await ledgerOf(h.board, top))
        if (e.status === 'running')
          await h.board.completeExecution(e.id, { status: 'failed', error: 'process died' })
      h.board.forceRelease(top)

      const next = makeHarness({ board: h.board, reportUps: outbox })
      await next.orchestrator.resume()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const again = next.delivered.filter((d) => d.agentId === 'a2')
      expect(again).toHaveLength(1)
      // What the lost run carried was never settled, so this one has it.
      expect(again[0]!.context).toContain('b result')
    })

    it('a sub-task failure reaches the follow-up, marked, and the parent does not read as done', async () => {
      const { h, top } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.orchestrator.onEvent(sk('a4'), failedDoneEvent('r4', 'error', 'provider exploded'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      expect(turn!.context).toContain('provider exploded')
      expect(turn!.context).toContain('DID NOT COMPLETE')
      expect(turn!.task).toMatch(/did not finish/i)

      await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'part a is in'), stampOf(turn!))
      expect(statusOf(h, top)).toBe('blocked')
      const wait = (await h.board.getTask(top))!.task['waitingOn'] as string
      expect(wait).toContain('person')
      expect(wait).toContain('part b')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLeader = reflections(h.delivered).find((r) => r.agentId === 'leader')
      expect(toLeader!.task).toMatch(/DID NOT COMPLETE|needs a person/)
    })

    it('an agent that made up for a failed sub-task closes it, and it says so', async () => {
      const { h, top } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.orchestrator.onEvent(sk('a4'), failedDoneEvent('r4', 'error', 'provider exploded'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      h.board.seedResultClaim(top, { outcome: 'done', summary: 'I did part b myself.' })
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'part b done by me'), stampOf(turn!))
      expect(statusOf(h, top)).toBe('done')
      expect(
        h.board.comments.some(
          (c) => c.taskId === top && /did not finish/.test(c.body) && c.body.includes('part b'),
        ),
      ).toBe(true)
    })

    it('a sub-task waiting on a person keeps the parent waiting', async () => {
      const { h, top, b } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.board.updateStatus(b, 'blocked', {
        waitingOn: { kind: 'question', questionId: 'q1' },
      })
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'I asked which colour.'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(statusOf(h, top)).toBe('blocked')
      expect(followUps(h, 'a2')).toEqual([])
    })

    it('a cancelled sub-task closes, and the parent can be done over it, saying so', async () => {
      const { h, top, a, b } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      expect(statusOf(h, a)).toBe('done')
      await h.board.updateStatus(b, 'cancelled')
      await h.orchestrator.personMovedTask(b, 'cancelled')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const [turn] = followUps(h, 'a2')
      expect(turn!.context).toContain('Do NOT redo')
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r5', 'part a is what we have'),
        stampOf(turn!),
      )
      expect(statusOf(h, top)).toBe('done')
      expect(h.board.comments.some((c) => c.taskId === top && /cancelled/.test(c.body))).toBe(true)
    })

    it('a follow-up that hands out more waits again', async () => {
      const { h, top } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r5', 'one more. <delegate to="@Design Boo">part c</delegate>'),
        stampOf(turn!),
      )
      expect(statusOf(h, top)).toBe('blocked')
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r6', 'c result'))
      await vi.advanceTimersByTimeAsync(0)
      expect(followUps(h, 'a2')).toHaveLength(2)
    })

    it('a hand-off the board refused comes back in one follow-up, and repeating it does not loop', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">mid task</delegate>'),
      )
      const mid = h.board.created.find((t) => t.title === 'mid task')!.id
      // Back up the chain: refused, and it has not heard yet.
      const back = '<delegate to="@Bug Boo">back to you</delegate>'
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', `mine is done. ${back}`))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const turns = followUps(h, 'a3')
      expect(turns).toHaveLength(1)
      expect(turns[0]!.context).toMatch(/was not started/)
      // It asks again in its follow-up. It was told once, so nothing more comes back,
      // and nothing is out: the task finishes instead of starting another turn.
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r4', `still. ${back}`), stampOf(turns[0]!))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 3)
      expect(followUps(h, 'a3')).toHaveLength(1)
      expect(statusOf(h, mid)).toBe('done')
    })

    it('a run that ended before its sub-task reported still gets the turn', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      const [top] = idsOf(h.board)
      // Handed out by a tool call mid-run, and it reports while the run is still going.
      await h.orchestrator.onEvent(
        sk('a2'),
        toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'quick part' }),
      )
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'quick result'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(h.delivered.filter((d) => d.agentId === 'a2' && d.origin.kind === 'wake')).toEqual([])

      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'my half is done'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      expect(turn!.context).toContain('quick result')
      expect(statusOf(h, top!)).toBe('in_progress')
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r4', 'all of it'), stampOf(turn!))
      expect(statusOf(h, top!)).toBe('done')
    })

    it('a person-assigned parent waits too, and keeps its result on its card', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      const task = await h.board.createTask({
        title: 'Ship the launch post',
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment('a2', 'n-launch'),
      })
      expect(await h.orchestrator.dispatchTask(task!.id)).toBe('started')
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'drafted. <delegate to="@Design Boo">make the banner</delegate>'),
      )
      expect(statusOf(h, task!.id)).toBe('blocked')
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'banner made'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      expect(turn!.origin).toMatchObject({ kind: 'wake', assigned: true })
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r4', 'post and banner'), stampOf(turn!))
      expect(statusOf(h, task!.id)).toBe('done')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
    })

    it('the lead waits on its own task too, and its summary reaches the chat', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      const task = await h.board.createTask({
        title: 'Plan the launch',
        teamId: 't1',
        sourceDelegationId: encodeHumanAssignment('leader', 'n-plan'),
      })
      expect(await h.orchestrator.dispatchTask(task!.id)).toBe('started')
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', 'on it. <delegate to="@Design Boo">make the banner</delegate>'),
      )
      expect(statusOf(h, task!.id)).toBe('blocked')
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'banner made'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const [turn] = followUps(h, 'leader')
      expect(turn!.origin).toMatchObject({ kind: 'wake', inChat: true })
      expect(turn!.context).toContain('banner made')
      // No update of its own: the follow-up is how the lead hears.
      expect(reflections(h.delivered).filter((r) => r.agentId === 'leader')).toEqual([])
      await h.orchestrator.onEvent(sk('leader'), doneEvent('r4', 'all planned'), stampOf(turn!))
      expect(statusOf(h, task!.id)).toBe('done')
    })

    it('a result that comes back on a closed task is still a follow-up on it, writing no status', async () => {
      const { h, top, b } = await parentWithTwo()
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      // A person decides the parent while one sub-task still runs.
      await h.board.updateStatus(top, 'in_progress')
      await h.board.updateStatus(top, 'done')
      await h.orchestrator.personMovedTask(top, 'done')
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      expect(statusOf(h, b)).toBe('done')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const late = reflections(h.delivered).find(
        (r) => r.agentId === 'a2' && r.task.includes('b result'),
      )
      expect(late!.origin).toMatchObject({ kind: 'system', forTaskId: top })
      const updates = h.board.statusUpdates.filter((u) => u.taskId === top).length
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'a late word'), {
        reportForTaskId: top,
        stopGen: 0,
      })
      expect(h.board.statusUpdates.filter((u) => u.taskId === top)).toHaveLength(updates)
      expect(statusOf(h, top)).toBe('done')
    })

    describe('a person’s Stop', () => {
      it('fires no follow-up, and the parent reads as stopped, with a way out', async () => {
        let gen = 0
        const { h, top, a, b } = await parentWithTwo({ stopGen: () => gen })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        expect(statusOf(h, a)).toBe('done')
        gen = 1
        await h.orchestrator.markStopped()
        await h.orchestrator.onEvent(sk('a4'), failedDoneEvent('r4', 'aborted', ''), {
          reportForTaskId: null,
          stopGen: 0,
        })
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
        await h.orchestrator.sweepStaleSessions()
        await h.orchestrator.resume()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
        // Not Blocked waiting on work that will never report: To do, stopped, as any
        // run a Stop ended. A person's Retry is the way out.
        expect(statusOf(h, top)).toBe('todo')
        const ledger = await ledgerOf(h.board, top)
        expect(ledger.at(-1)!.status).toBe('cancelled')
        expect(statusOf(h, b)).toBe('todo')
      })

      it('a sub-task that still ended well after the Stop starts nothing', async () => {
        let gen = 0
        const { h, top } = await parentWithTwo({ stopGen: () => gen })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        gen = 1
        await h.orchestrator.markStopped()
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'), {
          reportForTaskId: null,
          stopGen: 0,
        })
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
        expect(statusOf(h, top)).toBe('todo')
      })

      it('a Retry of the stopped parent runs it with what came back', async () => {
        let gen = 0
        const outbox = new MemoryReportUps()
        const { h, top } = await parentWithTwo({ stopGen: () => gen, reportUps: outbox })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        gen = 1
        await h.orchestrator.markStopped()
        await h.orchestrator.onEvent(sk('a4'), failedDoneEvent('r4', 'aborted', ''), {
          reportForTaskId: null,
          stopGen: 0,
        })
        expect(await h.orchestrator.dispatchTask(top)).toBe('started')
        const turn = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
        expect(turn.context).toContain('a result')
        // The sub-task the Stop halted will not report by itself, so nothing waits on it:
        // this run ends with that said, and the parent goes to a person.
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'part a only'), {
          ...stampOf(turn),
          stopGen: 1,
        })
        expect(statusOf(h, top)).toBe('blocked')
        expect((await h.board.getTask(top))!.task['waitingOn']).toContain('part b')
      })
    })

    describe('a pause, which is not a Stop', () => {
      const NOTE = 'Paused by a person. This run was stopped and starts again on resume.'
      const onAgent =
        (id: string) =>
        ({ agentId }: { agentId: string }): boolean =>
          agentId === id

      it('a sub-task it stopped is still out: the run that handed it out waits, and no person is asked', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(
          sk('a2'),
          toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'part a' }),
        )
        const a = h.board.created.find((t) => t.title === 'part a')!.id
        expect(await h.orchestrator.pauseRuns(onAgent('a3'), NOTE)).toEqual([a])
        expect(statusOf(h, a)).toBe('todo')

        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'my part is written'))
        // Waiting on its sub-task, and on nobody: read as a Stop, this card would tell a
        // person to retry a sub-task that comes back by itself.
        expect(statusOf(h, top!)).toBe('blocked')
        const waiting = (await h.board.getTask(top!))!.task['waitingOn']
        expect(waiting).toContain('subtasks')
        expect(waiting).not.toContain('did not finish')
        await h.board.releaseSubtaskWait(top!)
        expect(statusOf(h, top!)).toBe('blocked')

        // The resume: the sub-task runs again, and its ending is what the parent waited for.
        await h.orchestrator.resume()
        expect(statusOf(h, a)).toBe('in_progress')
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await vi.advanceTimersByTimeAsync(0)
        const [turn] = followUps(h, 'a2')
        expect(turn!.task).toContain('1 done')
        expect(turn!.task).not.toContain('Did not finish')
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r4', 'all in'), stampOf(turn!))
        expect(statusOf(h, top!)).toBe('done')
        expect(h.board.comments.some((c) => /closed over/.test(c.body))).toBe(false)
      })

      it('a follow-up it stops loses nothing: its results wait uncounted and ride the run after', async () => {
        const outbox = new MemoryReportUps()
        const { h, top } = await parentWithTwo({ reportUps: outbox })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
        await vi.advanceTimersByTimeAsync(0)
        const [turn] = followUps(h, 'a2')
        expect(turn!.context).toContain('b result')

        expect(await h.orchestrator.pauseRuns(onAgent('a2'), NOTE)).toEqual([top])
        expect(h.aborted).toContain(sk('a2'))
        expect(statusOf(h, top)).toBe('todo')
        expect((await ledgerOf(h.board, top)).at(-1)).toMatchObject({
          status: 'cancelled',
          errorClass: 'Paused',
        })
        // The stopped run's ending, which the stamp says a pause caused.
        await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r5', 'aborted', ''), {
          ...stampOf(turn!),
          stoppedByPause: true,
        })
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        await h.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(statusOf(h, top)).toBe('todo')
        expect(reflections(h.delivered)).toEqual([])
        const waiting = outbox.pending().filter((r) => r.item.forTaskId === top)
        expect(waiting.map((r) => r.replays)).toEqual([0, 0])

        await h.orchestrator.resume()
        const again = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
        expect(again.context).toContain('a result')
        expect(again.context).toContain('b result')
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r6', 'all in'), stampOf(again))
        expect(statusOf(h, top)).toBe('done')
        expect(outbox.unsettledFor('a2')).toEqual([])
      })

      it('a report it returned counts like any other once a later run has had it', async () => {
        const outbox = new MemoryReportUps()
        const { h, top } = await parentWithTwo({ reportUps: outbox })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
        await vi.advanceTimersByTimeAsync(0)
        const [turn] = followUps(h, 'a2')
        await h.orchestrator.pauseRuns(onAgent('a2'), NOTE)
        await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r5', 'aborted', ''), {
          ...stampOf(turn!),
          stoppedByPause: true,
        })
        await h.orchestrator.resume()
        const again = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
        expect(again.reportUpIds).toHaveLength(2)
        // That run fails for itself, and a person closes the task: its reports go out late.
        await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r6', 'error', 'x'), stampOf(again))
        await h.board.updateStatus(top, 'in_progress')
        await h.board.updateStatus(top, 'done')
        await h.orchestrator.personMovedTask(top, 'done')
        await h.orchestrator.sweepStaleSessions()
        const late = outbox.pending().filter((r) => r.item.forTaskId === top)
        expect(late.map((r) => r.replays)).toEqual([1, 1])
      })

      it('a late result for a paused recipient waits, uncounted, and goes out after the resume', async () => {
        const outbox = new MemoryReportUps()
        let paused = false
        const { h, top } = await parentWithTwo({
          reportUps: outbox,
          runHeldBy: ({ agentId }) => (paused && agentId === 'a2' ? NOTE : null),
        })
        await h.board.updateStatus(top, 'in_progress')
        await h.board.updateStatus(top, 'done')
        await h.orchestrator.personMovedTask(top, 'done')
        paused = true
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        for (let i = 0; i < 3; i++) {
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
          await h.orchestrator.sweepStaleSessions()
        }
        expect(reflections(h.delivered).filter((r) => r.agentId === 'a2')).toEqual([])
        expect(
          outbox
            .pending()
            .filter((r) => r.item.summary.includes('a result'))
            .map((r) => r.replays),
        ).toEqual([0])

        paused = false
        await h.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(
          reflections(h.delivered).filter((r) => r.agentId === 'a2' && r.task.includes('a result')),
        ).toHaveLength(1)
      })

      it('a person’s Stop during a pause is a Stop: the run a pause stopped does not come back', async () => {
        let gen = 0
        const { h, top, a } = await parentWithTwo({ stopGen: () => gen })
        await h.orchestrator.pauseRuns(onAgent('a3'), NOTE)
        expect((await ledgerOf(h.board, a)).at(-1)!.errorClass).toBe('Paused')
        const before = h.delivered.length

        gen = 1
        await h.orchestrator.markStopped()
        expect((await ledgerOf(h.board, a)).at(-1)!.errorClass ?? null).toBeNull()
        await h.orchestrator.resume()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(h.delivered).toHaveLength(before)
        expect(statusOf(h, a)).toBe('todo')
        expect(statusOf(h, top)).toBe('todo')
      })
    })

    describe('report_result', () => {
      it('a failure claim stops a Done, and says what the agent said', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        h.board.seedResultClaim(top!, { outcome: 'not_done', summary: 'The API key is missing.' })
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'I tried.'))
        expect(statusOf(h, top!)).toBe('blocked')
        const wait = (await h.board.getTask(top!))!.task['waitingOn'] as string
        expect(wait).toContain('The API key is missing.')
        // The run itself ended normally, as a self-block's does.
        expect((await ledgerOf(h.board, top!)).at(-1)!.status).toBe('succeeded')
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const toLeader = reflections(h.delivered).find((r) => r.agentId === 'leader')
        expect(toLeader!.task).toContain('DID NOT COMPLETE')
        expect(toLeader!.task).toContain('I tried.')
      })

      it('a failure claim with nothing else to say still tells the delegator why', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        h.board.seedResultClaim(top!, { outcome: 'not_done', summary: 'No key.' })
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top!)).toBe('blocked')
        expect((await h.board.getTask(top!))!.task['waitingOn']).toContain('No key.')
        expect(deliveredTo(h.delivered, 'a2')).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(h.delivered).find((r) => r.agentId === 'leader')!.task).toContain(
          'No key.',
        )
      })

      it('a failure claim does not wait for the sub-tasks it left running', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(
          sk('a2'),
          toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'part a' }),
        )
        h.board.seedResultClaim(top!, { outcome: 'not_done', summary: 'Wrong approach.' })
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'giving up'))
        expect(statusOf(h, top!)).toBe('blocked')
        expect((await h.board.getTask(top!))!.task['waitingOn']).toContain('Wrong approach.')
      })

      it('a success claim changes nothing about a task with no check', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        h.board.seedResultClaim(top!, { outcome: 'done', summary: 'All good.' })
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'finished'))
        expect(statusOf(h, top!)).toBe('done')
      })

      it('an empty reply takes the words of the claim', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        h.board.seedResultClaim(top!, {
          outcome: 'done',
          summary: 'Wrote the parser.',
          deliverables: ['src/parser.ts'],
        })
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top!)).toBe('done')
        // It reported, so it is no empty reply and earns no extra turn.
        expect(deliveredTo(h.delivered, 'a2')).toHaveLength(1)
        const said = h.board.comments.filter((c) => c.taskId === top).map((c) => c.body)
        expect(said.some((b) => b.includes('Wrote the parser.'))).toBe(true)
        expect(said.some((b) => b.includes('src/parser.ts'))).toBe(true)
      })

      it('an agent that never calls it behaves as before', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'finished'))
        expect(statusOf(h, top!)).toBe('done')
        expect(h.board.comments.filter((c) => c.taskId === top).map((c) => c.body)).toEqual([
          'finished',
        ])
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(h.delivered).find((r) => r.agentId === 'leader')!.task).toContain(
          'finished',
        )
      })
    })

    it('a chain waits level by level, and the lead hears once, when the top is done', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">mid task</delegate>'),
      )
      await h.orchestrator.onEvent(
        sk('a3'),
        doneEvent('r3', '<delegate to="@Test Boo">leaf task</delegate>'),
      )
      const [top, mid, leaf] = idsOf(h.board)
      expect([statusOf(h, top!), statusOf(h, mid!)]).toEqual(['blocked', 'blocked'])
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'leaf result'))
      expect(statusOf(h, leaf!)).toBe('done')
      await vi.advanceTimersByTimeAsync(0)
      // The middle's follow-up: the top still waits, because the middle is not closed.
      const midTurn = followUps(h, 'a3')
      expect(midTurn).toHaveLength(1)
      expect(midTurn[0]!.context).toContain('leaf result')
      expect(statusOf(h, top!)).toBe('blocked')
      expect(followUps(h, 'a2')).toEqual([])

      await h.orchestrator.onEvent(sk('a3'), doneEvent('r5', 'mid plus leaf'), stampOf(midTurn[0]!))
      expect(statusOf(h, mid!)).toBe('done')
      await vi.advanceTimersByTimeAsync(0)
      const topTurn = followUps(h, 'a2')
      expect(topTurn).toHaveLength(1)
      expect(topTurn[0]!.context).toContain('mid plus leaf')

      await h.orchestrator.onEvent(sk('a2'), doneEvent('r6', 'all three'), stampOf(topTurn[0]!))
      expect(statusOf(h, top!)).toBe('done')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLeader = reflections(h.delivered).filter((r) => r.agentId === 'leader')
      expect(toLeader).toHaveLength(1)
      expect(toLeader[0]!.task).toContain('all three')
    })

    it('a follow-up that fails leaves the parent with a person, and what it carried waits', async () => {
      const outbox = new MemoryReportUps()
      const { h, top } = await parentWithTwo({ reportUps: outbox })
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(0)
      const [turn] = followUps(h, 'a2')
      await h.orchestrator.onEvent(
        sk('a2'),
        failedDoneEvent('r5', 'error', 'provider down'),
        stampOf(turn!),
      )
      expect(statusOf(h, top)).toBe('blocked')
      expect((await h.board.getTask(top))!.task['waitingOn']).toContain('failure')
      // Nothing is sent by itself, however often the sweep comes.
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered).filter((r) => r.agentId === 'a2')).toEqual([])
      // A person's Retry takes them.
      await h.board.updateStatus(top, 'todo')
      expect(await h.orchestrator.dispatchTask(top)).toBe('started')
      expect(h.delivered.filter((d) => d.agentId === 'a2').at(-1)!.context).toContain('a result')
    })

    it('a person restarting a waiting parent runs it with what is in, and it waits again', async () => {
      const outbox = new MemoryReportUps()
      const { h, top } = await parentWithTwo({ reportUps: outbox })
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await h.board.updateStatus(top, 'todo')
      expect(await h.orchestrator.dispatchTask(top)).toBe('started')
      const retry = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
      expect(retry.context).toContain('a result')
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'looked again'), stampOf(retry))
      expect(statusOf(h, top)).toBe('blocked')

      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(0)
      const last = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
      // What the earlier run heard is not sent twice, and the message still names both.
      expect(last.context).toContain('b result')
      expect(last.context).not.toContain('a result')
      expect(last.task).toContain('2 done')
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r6', 'all in'), stampOf(last))
      expect(statusOf(h, top)).toBe('done')
    })

    it('a person moving the waiting parent to Done is final, and nothing runs it', async () => {
      const { h, top, a } = await parentWithTwo()
      await h.board.updateStatus(top, 'in_progress')
      await h.board.updateStatus(top, 'done')
      await h.orchestrator.personMovedTask(top, 'done')
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      expect(statusOf(h, a)).toBe('done')
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(statusOf(h, top)).toBe('done')
      expect(followUps(h, 'a2')).toEqual([])
    })

    it('a repeat of a hand-off that waits on its sub-tasks finds it, and makes no second task', async () => {
      const { h, top } = await parentWithTwo()
      expect(statusOf(h, top)).toBe('blocked')
      const before = h.board.taskCount()
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r9', '<delegate to="@Bug Boo">top task</delegate>'),
      )
      expect(h.board.taskCount()).toBe(before)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLeader = reflections(h.delivered).find((r) => r.agentId === 'leader')!
      expect(toLeader.task).toContain('already on the board')
    })

    describe('how a run ended, on work it handed out', () => {
      const RATE_LIMIT = '429 rate_limit_error: too many requests'
      const nudges = (h: Harness): Delivered[] =>
        h.delivered.filter((d) => d.task.startsWith('[No reply]'))
      /** The leader hands Bug Boo 'top task', which hands out one sub-task by tool. */
      async function parentWithOne(): Promise<{ h: Harness; top: string; a: string }> {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(
          sk('a2'),
          toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'part a' }),
        )
        const a = h.board.created.find((t) => t.title === 'part a')!.id
        return { h, top: top!, a }
      }

      it('a run that ends with no text and work still out waits, with no extra turn', async () => {
        const { h, top } = await parentWithOne()
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top)).toBe('blocked')
        expect((await h.board.getTask(top))!.task['waitingOn']).toContain('subtasks')
        expect(nudges(h)).toEqual([])
        expect(deliveredTo(h.delivered, 'a2')).toHaveLength(1)
      })

      it('a silent follow-up over the work it handed out closes it, with no extra turn', async () => {
        const { h, top } = await parentWithOne()
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await vi.advanceTimersByTimeAsync(0)
        const [turn] = followUps(h, 'a2')
        expect(turn).toBeDefined()
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r4', ''), stampOf(turn!))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top)).toBe('done')
        expect(nudges(h)).toEqual([])
        expect(h.board.comments.some((c) => c.taskId === top && /handed/i.test(c.body))).toBe(true)
      })

      it('a silent follow-up over a sub-task that failed goes to a person, with no extra turn', async () => {
        const { h, top } = await parentWithOne()
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
        await h.orchestrator.onEvent(sk('a3'), failedDoneEvent('r3', 'error', 'it broke'))
        await vi.advanceTimersByTimeAsync(0)
        const [turn] = followUps(h, 'a2')
        expect(turn!.task).toContain('Did not finish')
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r4', ''), stampOf(turn!))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top)).toBe('blocked')
        expect((await h.board.getTask(top))!.task['waitingOn']).toContain('did not finish')
        expect(nudges(h)).toEqual([])
      })

      it('a follow-up out of room after a continuation gets no second one', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        // Out of room once: its one continuation, in which it hands work out and waits.
        await h.orchestrator.onEvent(sk('a2'), failedDoneEvent('r2', 'max_turns', 'partial'))
        await vi.advanceTimersByTimeAsync(0)
        expect(deliveredTo(h.delivered, 'a2')).toHaveLength(2)
        await h.orchestrator.onEvent(
          sk('a2'),
          toolCallEvent('r3', 'team_delegate', { assignee: 'Design Boo', task: 'part a' }),
        )
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r3', 'handed the rest on'))
        expect(statusOf(h, top!)).toBe('blocked')
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r4', 'a result'))
        await vi.advanceTimersByTimeAsync(0)
        const [turn] = followUps(h, 'a2')
        expect(turn).toBeDefined()
        // Out of room again on the follow-up: the same work, so no second continuation.
        await h.orchestrator.onEvent(
          sk('a2'),
          failedDoneEvent('r5', 'max_turns', 'still partial'),
          stampOf(turn!),
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top!)).toBe('blocked')
        expect((await h.board.getTask(top!))!.task['waitingOn']).toContain('out_of_room')
        expect(deliveredTo(h.delivered, 'a2')).toHaveLength(3)
      })

      it('a sub-task waiting to retry keeps its parent waiting, and its success starts one follow-up', async () => {
        const { h, top, b } = await parentWithTwo()
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await h.orchestrator.onEvent(sk('a4'), errorEvent('r4', RATE_LIMIT, true))
        expect(statusOf(h, b)).toBe('todo')
        expect((await h.board.getTask(b))!.task['waitingOn']).toContain('retry')
        // Its parent reads it as coming, on the write's path and on the pump's.
        await h.board.releaseSubtaskWait(top)
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(statusOf(h, top)).toBe('blocked')
        expect(followUps(h, 'a2')).toEqual([])
        const waiting = (await h.board.getTask(top))!.task['waitingOn']
        expect(waiting).not.toContain('did not finish')

        await vi.advanceTimersByTimeAsync(40_000)
        expect(statusOf(h, b)).toBe('in_progress')
        expect(followUps(h, 'a2')).toEqual([])
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r5', 'b result'))
        await vi.advanceTimersByTimeAsync(0)
        const turns = followUps(h, 'a2')
        expect(turns).toHaveLength(1)
        expect(turns[0]!.task).toContain('2 done')
        expect(turns[0]!.task).not.toContain('Did not finish')
      })

      it('a sub-task whose retries ran out is closed, not done, and its parent gets one turn', async () => {
        const { h, top, b } = await parentWithTwo()
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await h.orchestrator.onEvent(sk('a4'), errorEvent('r4', RATE_LIMIT, true))
        await vi.advanceTimersByTimeAsync(40_000)
        await h.orchestrator.onEvent(sk('a4'), errorEvent('r5', RATE_LIMIT, true))
        expect(followUps(h, 'a2')).toEqual([])
        await vi.advanceTimersByTimeAsync(80_000)
        await h.orchestrator.onEvent(sk('a4'), errorEvent('r6', RATE_LIMIT, true))
        expect(statusOf(h, b)).toBe('blocked')
        expect((await h.board.getTask(b))!.task['waitingOn']).toContain('provider')
        await vi.advanceTimersByTimeAsync(0)
        const turns = followUps(h, 'a2')
        expect(turns).toHaveLength(1)
        expect(turns[0]!.task).toContain('Did not finish')
        expect(statusOf(h, top)).toBe('in_progress')
      })

      it('a sub-task waiting for room in a budget is still coming', async () => {
        const { h, top, b } = await parentWithTwo()
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await h.orchestrator.onEvent(
          sk('a4'),
          errorEvent('r4', 'The budget is held.', true, BUDGET_HELD_CODE),
        )
        expect(statusOf(h, b)).toBe('todo')
        await h.board.releaseSubtaskWait(top)
        expect(statusOf(h, top)).toBe('blocked')
        expect(followUps(h, 'a2')).toEqual([])
        const waiting = (await h.board.getTask(top))!.task['waitingOn']
        expect(waiting).not.toContain('did not finish')
      })

      it('a sub-task a hard cap stopped is closed, not done: its parent gets its turn', async () => {
        const { h, top, b } = await parentWithTwo()
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await h.orchestrator.onEvent(
          sk('a4'),
          errorEvent('r4', 'The budget is paused.', true, BUDGET_REFUSED_CODE),
        )
        expect(statusOf(h, b)).toBe('blocked')
        await vi.advanceTimersByTimeAsync(0)
        const turns = followUps(h, 'a2')
        expect(turns).toHaveLength(1)
        expect(turns[0]!.task).toContain('Did not finish')
        expect(statusOf(h, top)).toBe('in_progress')
      })
    })

    describe('what the review found', () => {
      /** A check the test answers by hand, on one task only, moving the card as the
       *  server's does. */
      function checkOn(): {
        workCheck: WorkCheck
        watch: (board: CascadeBoard, taskId: string) => void
        answer: (r: WorkCheckResult) => void
      } {
        let target: { board: CascadeBoard; taskId: string } | null = null
        const pending: Array<(r: WorkCheckResult) => void> = []
        return {
          watch: (board, taskId) => {
            target = { board, taskId }
          },
          answer: (r) => pending.shift()!(r),
          workCheck: {
            async begin() {},
            async prepare(taskId) {
              const t = target
              if (!t || t.taskId !== taskId) return null
              return async () => {
                await t.board.updateStatus(taskId, 'in_review')
                return new Promise<WorkCheckResult>((resolve) => pending.push(resolve))
              }
            },
          },
        }
      }

      /** Two sub-tasks in, the second one failed, and the parent's follow-up started. */
      async function failedSecond(
        opts?: HarnessOpts,
      ): Promise<Awaited<ReturnType<typeof parentWithTwo>> & { turn: Delivered }> {
        const parent = await parentWithTwo(opts)
        await parent.h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        await parent.h.orchestrator.onEvent(sk('a4'), failedDoneEvent('r4', 'error', 'exploded'))
        await vi.advanceTimersByTimeAsync(0)
        return { ...parent, turn: followUps(parent.h, 'a2').at(-1)! }
      }

      /** Delegates down to a task at the depth limit, running on Test Boo. */
      async function atDepthLimit(opts?: HarnessOpts): Promise<{ h: Harness; deepest: string }> {
        const h = makeHarness({ reportUps: new MemoryReportUps(), ...opts })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">t1</delegate>'),
        )
        await h.orchestrator.onEvent(
          sk('a2'),
          doneEvent('r2', '<delegate to="@Design Boo">t2</delegate>'),
        )
        await h.orchestrator.onEvent(
          sk('a3'),
          doneEvent('r3', '<delegate to="@Test Boo">t3</delegate>'),
        )
        return { h, deepest: h.board.created.find((t) => t.title === 't3')!.id }
      }
      // To the lead: the cycle guard refuses anyone else on this chain first.
      const toLead = (words: string): string => `<delegate to="@Boo Zero">${words}</delegate>`

      it('a Stop during its check moves a parent over unfinished work to a person', async () => {
        let gen = 0
        const check = checkOn()
        const { h, top, turn } = await failedSecond({
          stopGen: () => gen,
          workCheck: check.workCheck,
        })
        check.watch(h.board, top)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'part a is in'), stampOf(turn))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top)).toBe('in_review')

        gen = 1
        await h.orchestrator.markStopped()
        expect(statusOf(h, top)).toBe('in_review')
        check.answer({ verdict: 'pass' })
        await vi.advanceTimersByTimeAsync(0)

        // Not left In review, with nothing that could ever move it.
        expect(statusOf(h, top)).toBe('blocked')
        expect((await h.board.getTask(top))!.task['waitingOn']).toContain('part b')
        // Not told a false story: the task was not released, and the run ended well.
        expect((await ledgerOf(h.board, top)).at(-1)!.status).toBe('succeeded')
        expect(h.board.comments.some((c) => c.taskId === top && /late result/.test(c.body))).toBe(
          false,
        )
        // A Stop starts nothing.
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(h.delivered).filter((r) => r.agentId === 'leader')).toEqual([])
      })

      it('a failed move there leaves the run open, so the next engine hands it to a person', async () => {
        const check = checkOn()
        const outbox = new MemoryReportUps()
        const { h, top, turn } = await failedSecond({
          workCheck: check.workCheck,
          reportUps: outbox,
        })
        check.watch(h.board, top)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'part a is in'), stampOf(turn))
        await vi.advanceTimersByTimeAsync(0)
        const update = h.board.updateStatus.bind(h.board)
        h.board.updateStatus = async (id, status, opts) =>
          id === top && status === 'blocked' ? false : update(id, status, opts)
        check.answer({ verdict: 'pass' })
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top)).toBe('in_review')
        expect(await openRuns(h, top)).toBe(1)

        h.board.updateStatus = update
        h.orchestrator.reset()
        const next = makeHarness({
          board: h.board,
          reportUps: outbox,
          workCheck: check.workCheck,
        })
        await next.orchestrator.resume()
        expect(statusOf(next, top)).toBe('blocked')
      })

      it('a depth refusal repeated in the same words does not start another turn', async () => {
        const { h, deepest } = await atDepthLimit()
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', toLead('the same thing')))
        await vi.advanceTimersByTimeAsync(0)
        const turns = followUps(h, 'a4')
        expect(turns).toHaveLength(1)
        expect(turns[0]!.context).toMatch(/max delegation depth/)

        await h.orchestrator.onEvent(
          sk('a4'),
          doneEvent('r5', `still. ${toLead('the same thing')}`),
          stampOf(turns[0]!),
        )
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(followUps(h, 'a4')).toHaveLength(1)
        expect(statusOf(h, deepest)).toBe('done')
      })

      it('refused hand-offs in new words every time cannot keep a task going', async () => {
        const outbox = new MemoryReportUps()
        const { h, deepest } = await atDepthLimit({ reportUps: outbox })
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', toLead('words 0')))
        for (let i = 1; i <= 6 && statusOf(h, deepest) !== 'done'; i++) {
          // Runs with nothing to show, so the no-progress brake spaces them out.
          await vi.advanceTimersByTimeAsync(BRAKE_FIRST_WAIT_MS + 1)
          await h.orchestrator.resume()
          const turn = followUps(h, 'a4').at(-1)!
          await h.orchestrator.onEvent(sk('a4'), doneEvent(`r${i + 4}`, toLead(`words ${i}`)), {
            ...stampOf(turn),
          })
        }
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
        await h.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
        expect(followUps(h, 'a4')).toHaveLength(MAX_REFUSAL_TURNS)
        expect(statusOf(h, deepest)).toBe('done')
        // What it was not told again is said on the card, and starts nothing later.
        expect(outbox.unsettledFor('a4')).toEqual([])
        expect(
          h.board.comments.some((c) => c.taskId === deepest && /not told again/.test(c.body)),
        ).toBe(true)
        expect(reflections(h.delivered).filter((r) => r.agentId === 'a4')).toEqual([])
      })

      it('nor keep going once its task has closed', async () => {
        const { h, deepest } = await atDepthLimit()
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'all done'))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, deepest)).toBe('done')
        const late = (): Delivered[] => reflections(h.delivered).filter((r) => r.agentId === 'a4')
        for (let i = 0; i < 6; i++) {
          await h.orchestrator.onEvent(sk('a4'), doneEvent(`rL${i}`, toLead(`late ${i}`)), {
            reportForTaskId: deepest,
            stopGen: 0,
          })
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        }
        expect(late()).toHaveLength(MAX_REFUSAL_TURNS)
      })

      it('a pause holding a refusal spends none of its turns: it is told after the resume', async () => {
        const outbox = new MemoryReportUps()
        let paused = false
        const { h, deepest } = await atDepthLimit({
          reportUps: outbox,
          runHeldBy: ({ agentId }) => (paused && agentId === 'a4' ? 'Paused.' : null),
        })
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'all done'))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, deepest)).toBe('done')
        const late = (): Delivered[] => reflections(h.delivered).filter((r) => r.agentId === 'a4')

        paused = true
        for (let i = 0; i < MAX_REFUSAL_TURNS + 2; i++) {
          await h.orchestrator.onEvent(sk('a4'), doneEvent(`rL${i}`, toLead(`late ${i}`)), {
            reportForTaskId: deepest,
            stopGen: 0,
          })
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
          await h.orchestrator.sweepStaleSessions()
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        }
        expect(late()).toEqual([])
        expect(h.board.comments.some((c) => /not told again/.test(c.body))).toBe(false)
        expect(outbox.pending().map((r) => r.replays)).toEqual(
          Array.from({ length: outbox.pending().length }, () => 0),
        )

        paused = false
        await h.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(late().length).toBeGreaterThan(0)
      })

      it('a sub-task waiting on its own parent does not hold the parent', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(
          sk('a2'),
          toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'part a' }),
        )
        const child = h.board.created.find((t) => t.title === 'part a')!.id
        // What its `block_task` writes. The guard lets it through: the parent is not
        // waiting on anything yet.
        await h.board.updateStatus(child, 'blocked', {
          waitingOn: { kind: 'task', taskId: top! },
        })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'I need the parent first'))
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'my part is done'))
        await vi.advanceTimersByTimeAsync(0)
        // It hears what its sub-task said, and nothing it waits for is coming.
        const turn = followUps(h, 'a2').at(-1)
        if (turn)
          await h.orchestrator.onEvent(sk('a2'), doneEvent('r4', 'done on my side'), stampOf(turn))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top!)).toBe('done')
        // And its finishing is what frees the sub-task.
        expect(statusOf(h, child)).not.toBe('blocked')
      })

      it('a failed move at parking leaves the run open and the report on the card', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        const update = h.board.updateStatus.bind(h.board)
        h.board.updateStatus = async (id, status, opts) =>
          id === top && status === 'blocked' ? false : update(id, status, opts)
        await h.orchestrator.onEvent(
          sk('a2'),
          doneEvent('r2', 'my half. <delegate to="@Design Boo">part a</delegate>'),
        )
        expect(statusOf(h, top!)).toBe('in_progress')
        // Open, so the board's stale sweep can see this task and release it.
        expect(await openRuns(h, top!)).toBe(1)
        expect(h.orchestrator.taskForSession(sk('a2'))).toBeNull()
        expect(h.board.comments.some((c) => c.taskId === top && /my half/.test(c.body))).toBe(true)

        // What that sweep does: the run closes, the task goes back, and it runs again.
        h.board.updateStatus = update
        const open = (await ledgerOf(h.board, top!)).find((e) => e.status === 'running')!
        await h.board.completeExecution(open.id, { status: 'timed_out', error: 'swept' })
        h.board.forceRelease(top!)
        await h.orchestrator.resume()
        expect(statusOf(h, top!)).toBe('in_progress')
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'again'))
        expect(statusOf(h, top!)).toBe('blocked')
        expect((await h.board.getTask(top!))!.task['waitingOn']).toContain('subtasks')
      })

      it('a report whose write failed still reaches the follow-up that starts at once', async () => {
        const outbox = new MemoryReportUps()
        const { h, top } = await parentWithTwo({ reportUps: outbox })
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
        outbox.failRecords = 1
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', 'b result'))
        await vi.advanceTimersByTimeAsync(0)
        const turns = followUps(h, 'a2')
        expect(turns).toHaveLength(1)
        expect(turns[0]!.context).toContain('b result')
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'all in'), stampOf(turns[0]!))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
        expect(statusOf(h, top)).toBe('done')
        expect(followUps(h, 'a2')).toHaveLength(1)
      })

      it('and past the batch window, while its parent still runs', async () => {
        const outbox = new MemoryReportUps()
        const h = makeHarness({ reportUps: outbox })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        await h.orchestrator.onEvent(
          sk('a2'),
          toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'quick part' }),
        )
        // The first write and the flush's second try both fail.
        outbox.failRecords = 2
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'quick result'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'my half'))
        await vi.advanceTimersByTimeAsync(0)
        expect(followUps(h, 'a2').at(-1)!.context).toContain('quick result')
      })

      it('and it goes out on the task if a person closes the task first', async () => {
        const outbox = new MemoryReportUps()
        const h = makeHarness({ reportUps: outbox })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(
          sk('a2'),
          doneEvent(
            'r2',
            '<delegate to="@Design Boo">p</delegate><delegate to="@Test Boo">q</delegate>',
          ),
        )
        outbox.failRecords = 2
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'p result'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        await h.board.updateStatus(top!, 'in_progress')
        await h.board.updateStatus(top!, 'done')
        await h.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const late = reflections(h.delivered).find((r) => r.agentId === 'a2')
        expect(late?.task).toContain('p result')
        expect(late?.origin).toMatchObject({ kind: 'system', forTaskId: top })
      })

      it('a person retrying the sub-task that did not finish brings the parent back', async () => {
        const { h, top, b, turn } = await failedSecond()
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'part a is in'), stampOf(turn))
        expect(statusOf(h, top)).toBe('blocked')
        expect((await h.board.getTask(top))!.task['waitingOn']).toContain('Retry them')

        // Exactly what the card told them to do.
        await h.board.updateStatus(b, 'todo')
        expect(await h.orchestrator.dispatchTask(b)).toBe('started')
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r6', 'b result, second go'))
        await vi.advanceTimersByTimeAsync(0)
        const again = followUps(h, 'a2').at(-1)!
        expect(again).not.toBe(turn)
        expect(again.context).toContain('b result, second go')
        expect(statusOf(h, top)).toBe('in_progress')
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r7', 'all of it'), stampOf(again))
        expect(statusOf(h, top)).toBe('done')
      })

      it('with another still not finished it stays, and the card names only that one', async () => {
        const h = makeHarness({ reportUps: new MemoryReportUps() })
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">top task</delegate>'),
        )
        const [top] = idsOf(h.board)
        await h.orchestrator.onEvent(
          sk('a2'),
          doneEvent(
            'r2',
            '<delegate to="@Design Boo">part a</delegate><delegate to="@Test Boo">part b</delegate>',
          ),
        )
        const b = h.board.created.find((t) => t.title === 'part b')!.id
        await h.orchestrator.onEvent(sk('a3'), failedDoneEvent('r3', 'error', 'boom a'))
        await h.orchestrator.onEvent(sk('a4'), failedDoneEvent('r4', 'error', 'boom b'))
        await vi.advanceTimersByTimeAsync(0)
        const turn = followUps(h, 'a2').at(-1)!
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r5', 'neither is in'), stampOf(turn))
        const said = (await h.board.getTask(top!))!.task['waitingOn'] as string
        expect(said).toContain('part a')
        expect(said).toContain('part b')

        await h.board.updateStatus(b, 'todo')
        expect(await h.orchestrator.dispatchTask(b)).toBe('started')
        await h.orchestrator.onEvent(sk('a4'), doneEvent('r6', 'b result'))
        await vi.advanceTimersByTimeAsync(0)
        expect(statusOf(h, top!)).toBe('blocked')
        const now = (await h.board.getTask(top!))!.task['waitingOn'] as string
        expect(now).toContain('part a')
        expect(now).not.toContain('part b')
      })
    })

    it('counts a waiting parent as still outstanding for whoever handed it out', async () => {
      const { h } = await parentWithTwo()
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r9', '<delegate to="@Design Boo">another thing</delegate>'),
      )
      await vi.advanceTimersByTimeAsync(0)
      // Design Boo is on part a first; finish it, then its queued hand-off.
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'a result'))
      await vi.advanceTimersByTimeAsync(0)
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r10', 'another result'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const toLeader = reflections(h.delivered).find((r) => r.agentId === 'leader')!
      expect(toLeader.task).toContain('Still outstanding')
      expect(toLeader.task).toContain('top task')
      expect(toLeader.task).not.toContain('All of the work you handed off here is in')
    })
  })

  // ─── A delegate that blocks its own task ────
  // On a team run the agent may block the task it is working on, when it cannot
  // go on without a person. Its run then ends normally. That ending used to fail
  // the `done` write (blocked to done is illegal) and land in the "released or
  // reassigned" branch: the run was closed `cancelled`, which the fire policy
  // reads as a user Stop, and the delegator heard the result arrived too late.
  describe('createBoardOrchestrator: a delegate that blocked its own task', () => {
    it('keeps the task blocked and tells the delegator why, as a blocked task', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>'),
      )
      const t1 = idsOf(board)[0]!
      // Mid-run, the agent's own `block_task`.
      expect(await board.updateStatus(t1, 'blocked')).toBe(true)
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'I need the API key to go on.'))

      expect(board.statusOf(t1)).toBe('blocked')
      expect(board.completed).toHaveLength(1)
      expect(board.completed[0]!.outcome.status).toBe('succeeded')
      expect(board.comments.some((c) => c.taskId === t1 && c.body.includes('API key'))).toBe(true)

      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.sessionKey).toBe(sk('leader'))
      expect(refl[0]!.task).toContain('blocked')
      expect(refl[0]!.task).toContain('I need the API key to go on.')
      expect(refl[0]!.task).not.toMatch(/released|reassigned/)
    })

    it('leaves the steps waiting on it queued, so a Retry carries the plan on', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<plan><step to="@Bug Boo">s1</step><step to="@Design Boo">s2</step></plan>',
        ),
      )
      const [s1, s2] = idsOf(board)
      expect(await board.updateStatus(s1!, 'blocked')).toBe(true)
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'Blocked on access.'))
      expect(board.statusOf(s1!)).toBe('blocked')
      expect(board.statusOf(s2!)).toBe('todo')

      // The person's Retry: back to To do, run again, done. Step 2 then starts.
      expect(await board.updateStatus(s1!, 'todo')).toBe(true)
      expect(await orchestrator.dispatchTask(s1!)).toBe('started')
      await orchestrator.onEvent(sk('a2'), doneEvent('r3', 'Got access, step one done.'))
      expect(board.statusOf(s1!)).toBe('done')
      expect(delivered.at(-1)).toMatchObject({ agentId: 'a3', task: 's2' })
    })
  })

  // ─── A hand-off nobody can take ────
  // Both delegate tools answer before the engine acts. For a name the engine
  // could not match to a teammate, or the sender itself, nothing was created and
  // nothing came back: the sender read its tool's answer and waited forever.
  describe('createBoardOrchestrator: a hand-off that names no teammate', () => {
    const calls: Array<[string, Record<string, string>]> = [
      ['delegate', { assignee: 'Researcher', task: 'find the numbers' }],
      ['team_delegate', { assignee: 'Researcher', task: 'find the numbers' }],
      [
        'mcp__clawboo-teamchat__team_delegate',
        { assignee: 'Researcher', task: 'find the numbers' },
      ],
    ]

    it.each(calls)(
      'a %s call to an unknown name tells the sender it did not start',
      async (name, input) => {
        const { board, delivered, orchestrator } = makeHarness()
        await orchestrator.onEvent(sk('leader'), toolCallEvent('r1', name, input))
        expect(board.taskCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const refl = reflections(delivered)
        expect(refl).toHaveLength(1)
        expect(refl[0]!.sessionKey).toBe(sk('leader'))
        expect(refl[0]!.task).toContain('"Researcher"')
        expect(refl[0]!.task).toContain('did not start')
        // It names who the sender can hand work to.
        expect(refl[0]!.task).toContain('Bug Boo, Design Boo, Test Boo')
      },
    )

    it('a sessions_send to no teammate says no board task was made, and leaves the delivery to OpenClaw', async () => {
      // OpenClaw's own tool answers for itself and may have delivered the message
      // to a session outside the room, so the note must not say nothing comes back.
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r1', 'sessions_send', { label: 'Researcher', message: 'find the numbers' }),
      )
      expect(board.taskCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.task).toContain('"Researcher"')
      expect(refl[0]!.task).toContain('no board task was made')
      expect(refl[0]!.task).toContain('through OpenClaw')
      expect(refl[0]!.task).toContain('Bug Boo, Design Boo, Test Boo')
    })

    it('a hand-off to the sender itself tells the sender it did not start', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r1', 'delegate', { assignee: 'Boo Zero', task: 'do it' }),
      )
      expect(board.taskCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const refl = reflections(delivered)
      expect(refl).toHaveLength(1)
      expect(refl[0]!.task).toContain('yourself')
      expect(refl[0]!.task).toContain('did not start')
    })

    it('says so once for one call, even when the same event is seen twice', async () => {
      const { delivered, orchestrator } = makeHarness()
      const ev = toolCallEvent('r1', 'delegate', { assignee: 'Researcher', task: 'find it' })
      await orchestrator.onEvent(sk('leader'), ev)
      await orchestrator.onEvent(sk('leader'), ev)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(1)
    })

    it('is not told again when a later run repeats the same hand-off (no refusal loop)', async () => {
      // The refusal arrives as a new turn. A sender that repeats the same bad
      // hand-off in it is not handed another one.
      const { delivered, orchestrator } = makeHarness()
      const call = { assignee: 'Researcher', task: 'find it' }
      await orchestrator.onEvent(sk('leader'), toolCallEvent('r1', 'delegate', call))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(sk('leader'), toolCallEvent('r2', 'delegate', call))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(1)
    })

    it('tells the sender about each different task, even when two begin the same way', async () => {
      const { delivered, orchestrator } = makeHarness()
      const opening = 'Collect the numbers for the quarterly board report, every region, '.repeat(2)
      for (const [run, tail] of [
        ['r1', 'then chart revenue'],
        ['r2', 'then chart churn'],
      ] as const)
        await orchestrator.onEvent(
          sk('leader'),
          toolCallEvent(run, 'delegate', { assignee: 'Researcher', task: opening + tail }),
        )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const told = reflections(delivered)
        .map((r) => r.task)
        .join('\n')
      expect(told.match(/did not start/g)).toHaveLength(2)
    })

    it('a hand-off to a teammate still starts, with no refusal', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r1', 'team_delegate', { assignee: 'Bug Boo', task: 'fix it' }),
      )
      expect(board.taskCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toHaveLength(0)
    })
  })

  describe('createBoardOrchestrator: a task is made once', () => {
    const handOff = (to: string, task: string): string => `<delegate to="@${to}">${task}</delegate>`

    it('a replay of a hand-off, seen by the next engine after a restart, makes no second task', async () => {
      const first = makeHarness()
      const ev = doneEvent('r1', handOff('Bug Boo', 'fix the login'))
      await first.orchestrator.onEvent(sk('leader'), ev)
      expect(first.board.taskCount()).toBe(1)
      expect(deliveredTo(first.delivered, 'a2')).toHaveLength(1)

      const next = makeHarness({ board: first.board })
      await next.orchestrator.onEvent(sk('leader'), ev)
      expect(first.board.taskCount()).toBe(1)
      expect(deliveredTo(next.delivered, 'a2')).toEqual([])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(next.delivered)).toEqual([])
    })

    it('a plan replayed by the next engine makes no second steps', async () => {
      const first = makeHarness()
      const ev = doneEvent(
        'r1',
        '<plan><step to="@Bug Boo">one</step><step to="@Design Boo">two</step></plan>',
      )
      await first.orchestrator.onEvent(sk('leader'), ev)
      expect(first.board.taskCount()).toBe(2)
      const next = makeHarness({ board: first.board })
      await next.orchestrator.onEvent(sk('leader'), ev)
      expect(first.board.taskCount()).toBe(2)
    })

    it('one run handing out two long asks that start alike makes two tasks', async () => {
      const { board, orchestrator } = makeHarness()
      const start = 'Please look into the failing checks on the payments page and report '
      const ev = doneEvent(
        'r1',
        handOff('Bug Boo', `${start} what broke in the sandbox`) +
          handOff('Bug Boo', `${start} what broke in production`),
      )
      await orchestrator.onEvent(sk('leader'), ev)
      expect(board.taskCount()).toBe(2)
    })

    it('a later run handing out the same words gets the open task, and the sender is told once', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', handOff('Bug Boo', 'Write the docs')),
      )
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', handOff('Bug Boo', 'write the docs.')),
      )
      // Even to another teammate: one piece of work, one task.
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r3', handOff('Design Boo', 'Write the docs')),
      )
      expect(board.taskCount()).toBe(1)
      expect(deliveredTo(delivered, 'a3')).toEqual([])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const notes = reflections(delivered).filter((r) => /already/i.test(r.task))
      expect(notes).toHaveLength(1)
      expect(notes[0]!.sessionKey).toBe(sk('leader'))
      expect(notes[0]!.task).not.toMatch(/different title|reword|rename/i)
    })

    it('a found task is reported as open, not as a failure, and stays outstanding', async () => {
      const { delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', handOff('Bug Boo', 'Write the docs')),
      )
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', handOff('Bug Boo', 'Write the docs')),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const note = reflections(delivered).find((r) => /already/i.test(r.task))!.task
      expect(note).not.toMatch(/did NOT complete|DID NOT COMPLETE|failed with an error/)
      expect(note).not.toMatch(/reached a terminal state/)
      expect(note).toMatch(/Still outstanding: 1/)
      expect(note).toMatch(/Bug Boo/)
    })

    it('a plan that finds its step already on the board says so once, across the turns it starts', async () => {
      const { delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', handOff('Bug Boo', 'Write the docs')),
      )
      const plan = '<plan><step to="@Design Boo">Write the docs</step></plan>'
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', plan))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(sk('leader'), doneEvent('r3', plan))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).filter((r) => /already/i.test(r.task))).toHaveLength(1)
    })

    it('one turn asking two teammates the same thing makes two tasks, and a later retry makes none', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const ask =
        handOff('Bug Boo', 'What do you think?') + handOff('Design Boo', 'What do you think?')
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', ask))
      expect(board.taskCount()).toBe(2)
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
      expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
      // A later turn saying it again is a retry.
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', ask))
      expect(board.taskCount()).toBe(2)
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
      expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
    })

    /** One delivery of a lead turn on a runtime that resumes one native thread, so
     *  every turn's events carry the same run id. */
    const delivery = (deliveryId: string): RunStamp => ({
      reportForTaskId: null,
      stopGen: 0,
      deliveryId,
    })

    it('on a runtime that reuses its run id, later words after a closed task make a new task', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const ev = doneEvent('native-thread-1', handOff('Bug Boo', 'Run the test suite'))
      await orchestrator.onEvent(sk('leader'), ev, delivery('monday'))
      await orchestrator.onEvent(sk('a2'), doneEvent('rc1', 'all green'))
      expect(board.taskCount()).toBe(1)
      await orchestrator.onEvent(sk('leader'), ev, delivery('thursday'))
      expect(board.taskCount()).toBe(2)
      expect(deliveredTo(delivered, 'a2')).toHaveLength(2)
    })

    it('a replay of one delivery, seen by the next engine, still makes no second task', async () => {
      const first = makeHarness()
      const ev = doneEvent('native-thread-1', handOff('Bug Boo', 'Run the test suite'))
      await first.orchestrator.onEvent(sk('leader'), ev, delivery('monday'))
      await first.orchestrator.onEvent(sk('a2'), doneEvent('rc1', 'all green'))
      const next = makeHarness({ board: first.board })
      await next.orchestrator.onEvent(sk('leader'), ev, delivery('monday'))
      expect(first.board.taskCount()).toBe(1)
      expect(deliveredTo(next.delivered, 'a2')).toEqual([])
    })

    it('a replay does not hold a blocked task against the retry', async () => {
      const first = makeHarness()
      const ev = doneEvent('r1', handOff('Bug Boo', 'Run the test suite'))
      await first.orchestrator.onEvent(sk('leader'), ev)
      await first.orchestrator.onEvent(sk('a2'), failedDoneEvent('rc1', 'error', 'boom'))
      const next = makeHarness({ board: first.board })
      await next.orchestrator.onEvent(sk('leader'), ev)
      expect(first.board.taskCount()).toBe(2)
      expect(deliveredTo(next.delivered, 'a2')).toHaveLength(1)
    })

    it('a blocked task does not swallow the retry', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', handOff('Bug Boo', 'try this')))
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('rc', 'error', 'boom'))
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', handOff('Design Boo', 'try this')))
      expect(board.taskCount()).toBe(2)
      expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
    })

    it('a task a person stopped does not swallow the hand-off that restarts the work', async () => {
      let gen = 0
      const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', handOff('Bug Boo', 'try again')))
      gen += 1
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('rc', 'aborted', 'stopped'))
      expect(board.allStatuses()).toContain('todo')
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', handOff('Bug Boo', 'try again')))
      expect(board.taskCount()).toBe(2)
      expect(deliveredTo(delivered, 'a2')).toHaveLength(2)
    })

    it("a person's parked Backlog card, even bound to an agent, does not swallow a hand-off", async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await board.createTask({
        title: 'Clean the logs',
        teamId: 't1',
        status: 'backlog',
        sourceDelegationId: encodeHumanAssignment('a2', 'n1'),
      })
      const before = board.taskCount()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', handOff('Bug Boo', 'clean the logs')),
      )
      expect(board.taskCount()).toBe(before + 1)
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
    })

    it("a person's card with nobody on it does not swallow a hand-off", async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await board.createTask({ title: 'Clean the logs', teamId: 't1' })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', handOff('Bug Boo', 'clean the logs')),
      )
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
    })

    it('a plan may repeat a step, and each repeat is its own task', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<plan><step to="@Bug Boo">run the tests</step><step to="@Design Boo">fix what fails</step><step to="@Bug Boo">run the tests</step></plan>',
        ),
      )
      expect(board.taskCount()).toBe(3)
    })
  })

  describe('createBoardOrchestrator: no hand-off goes in a circle', () => {
    const handOff = (to: string, task: string): string => `<delegate to="@${to}">${task}</delegate>`

    /** The leader hands to Bug Boo, which hands to Design Boo. */
    const chain = async (h: ReturnType<typeof makeHarness>): Promise<void> => {
      await h.orchestrator.onEvent(sk('leader'), doneEvent('r1', handOff('Bug Boo', 'first job')))
      await h.orchestrator.onEvent(
        sk('a2'),
        toolCallEvent('r2', 'team_delegate', { assignee: 'Design Boo', task: 'second job' }),
      )
    }

    it('A to B to A is refused through a tool call, and the sender is told', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await chain(h)
      expect(h.board.taskCount()).toBe(2)
      await h.orchestrator.onEvent(
        sk('a3'),
        toolCallEvent('r3', 'team_delegate', { assignee: 'Bug Boo', task: 'back to you' }),
      )
      expect(h.board.taskCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // The sender's run is still going: it hears at its next turn, on this task.
      expect(reflections(h.delivered).filter((r) => r.sessionKey === sk('a3'))).toEqual([])
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'carried on without it'))
      await vi.advanceTimersByTimeAsync(0)
      const notes = h.delivered.filter((d) => d.sessionKey === sk('a3')).at(-1)!
      expect(notes.context).toMatch(/Bug Boo/)
      expect(notes.context).toMatch(/was not started/)
      expect(h.board.comments.some((c) => /Bug Boo/.test(c.body))).toBe(true)
    })

    it('A to B to A is refused through a closing message, which finishes the task first', async () => {
      const h = makeHarness()
      await chain(h)
      await h.orchestrator.onEvent(
        sk('a3'),
        doneEvent('r3', `Done. ${handOff('Bug Boo', 'back to you')}`),
      )
      expect(h.board.taskCount()).toBe(2)
    })

    it('A to B to C to A is refused for every agent up the chain', async () => {
      const h = makeHarness()
      await chain(h)
      await h.orchestrator.onEvent(
        sk('a3'),
        toolCallEvent('r3', 'team_delegate', { assignee: 'Test Boo', task: 'third job' }),
      )
      expect(h.board.taskCount()).toBe(3)
      await h.orchestrator.onEvent(
        sk('a4'),
        toolCallEvent('r4', 'team_delegate', { assignee: 'Design Boo', task: 'back up one' }),
      )
      await h.orchestrator.onEvent(
        sk('a4'),
        toolCallEvent('r4', 'team_delegate', { assignee: 'Bug Boo', task: 'back up two' }),
      )
      expect(h.board.taskCount()).toBe(3)
    })

    it('a plan with a step back up the chain is refused whole', async () => {
      const h = makeHarness()
      await chain(h)
      await h.orchestrator.onEvent(
        sk('a3'),
        doneEvent(
          'r3',
          '<plan><step to="@Test Boo">fine</step><step to="@Bug Boo">back</step></plan>',
        ),
      )
      expect(h.board.taskCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered).some((r) => /Plan not started/.test(r.task))).toBe(true)
    })

    it('an escalation to the lead goes through, though the lead delegated the chain', async () => {
      const h = makeHarness()
      await chain(h)
      await h.orchestrator.onEvent(
        sk('a3'),
        toolCallEvent('r3', 'team_delegate', { assignee: 'Boo Zero', task: 'I am stuck' }),
      )
      expect(h.board.taskCount()).toBe(3)
      expect(deliveredTo(h.delivered, 'leader').some((t) => /I am stuck/.test(t))).toBe(true)
    })

    it('a sideways hand-off to someone new goes through', async () => {
      const h = makeHarness()
      await chain(h)
      await h.orchestrator.onEvent(
        sk('a3'),
        toolCallEvent('r3', 'team_delegate', { assignee: 'Test Boo', task: 'for you' }),
      )
      expect(h.board.taskCount()).toBe(3)
    })

    it('tells the sender once, though it tries again on the turn the refusal starts', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await chain(h)
      const again = (run: string) =>
        h.orchestrator.onEvent(
          sk('a3'),
          toolCallEvent(run, 'team_delegate', { assignee: 'Bug Boo', task: 'back to you' }),
        )
      await again('r3')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await again('r4')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(outbox.unsettledFor('a3')).toHaveLength(1)
    })
  })

  describe('createBoardOrchestrator: the caps hold', () => {
    const tool = (run: string, task: string, assignee = 'Bug Boo'): RuntimeEvent =>
      toolCallEvent(run, 'team_delegate', { assignee, task })

    it('counts the hand-off cap per turn, across tool calls that are each their own event', async () => {
      const capHits: CapHit[] = []
      const { board, orchestrator } = makeHarness({
        caps: { maxFanout: 2 },
        onCapHit: (i) => capHits.push(i),
      })
      await orchestrator.onEvent(sk('leader'), tool('r1', 'one'))
      await orchestrator.onEvent(sk('leader'), tool('r1', 'two', 'Design Boo'))
      await orchestrator.onEvent(sk('leader'), tool('r1', 'three', 'Test Boo'))
      expect(board.taskCount()).toBe(2)
      expect(capHits.map((c) => c.kind)).toEqual(['fanout'])
    })

    it('gives each turn its own count, and a turn that ended gives back its count', async () => {
      const { board, orchestrator } = makeHarness({ caps: { maxFanout: 1 } })
      await orchestrator.onEvent(sk('leader'), tool('r1', 'one'))
      await orchestrator.onEvent(sk('leader'), tool('r1', 'two', 'Design Boo'))
      expect(board.taskCount()).toBe(1)
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', 'over'))
      await orchestrator.onEvent(sk('leader'), tool('r2', 'three', 'Design Boo'))
      expect(board.taskCount()).toBe(2)
    })

    it('a repeat of one hand-off in a turn uses no part of the cap', async () => {
      const { board, orchestrator } = makeHarness({ caps: { maxFanout: 2 } })
      await orchestrator.onEvent(sk('leader'), tool('r1', 'one'))
      await orchestrator.onEvent(sk('leader'), tool('r1', 'one'))
      await orchestrator.onEvent(sk('leader'), tool('r1', 'two', 'Design Boo'))
      expect(board.taskCount()).toBe(2)
    })

    it('refuses a plan too long, whole, and tells the sender', async () => {
      const capHits: CapHit[] = []
      const { board, delivered, orchestrator } = makeHarness({ onCapHit: (i) => capHits.push(i) })
      const steps = Array.from(
        { length: MAX_PLAN_STEPS + 1 },
        (_, i) => `<step to="@Bug Boo">step ${i}</step>`,
      )
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', `<plan>${steps.join('')}</plan>`))
      expect(board.taskCount()).toBe(0)
      expect(capHits.map((c) => c.kind)).toEqual(['plan_length'])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).some((r) => /Plan not started/.test(r.task))).toBe(true)
    })

    it('lets a plan of the most steps through', async () => {
      const { board, orchestrator } = makeHarness()
      const steps = Array.from(
        { length: MAX_PLAN_STEPS },
        (_, i) => `<step to="@Bug Boo">step ${i}</step>`,
      )
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', `<plan>${steps.join('')}</plan>`))
      expect(board.taskCount()).toBe(MAX_PLAN_STEPS)
    })

    /** A task Bug Boo is running, with `children` sub-tasks under it. */
    const parentWith = async (
      h: ReturnType<typeof makeHarness>,
      children: number,
    ): Promise<string> => {
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      const parent = idsOf(h.board)[0]!
      for (let i = 0; i < children; i += 1) {
        await h.board.createTask({ title: `child ${i}`, teamId: 't1', parentTaskId: parent })
      }
      return parent
    }

    it('caps a hand-off at the most sub-tasks one task can have', async () => {
      const capHits: CapHit[] = []
      const outbox = new MemoryReportUps()
      const h = makeHarness({ onCapHit: (i) => capHits.push(i), reportUps: outbox })
      await parentWith(h, 24)
      const before = h.board.taskCount()
      await h.orchestrator.onEvent(sk('a2'), tool('r2', 'one more', 'Design Boo'))
      expect(h.board.taskCount()).toBe(before)
      expect(deliveredTo(h.delivered, 'a3')).toEqual([])
      expect(capHits.map((c) => c.kind)).toEqual(['child_cap'])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // The sender's run is still going: the refusal waits for its next turn on the task.
      expect(outbox.unsettledFor('a2')).toHaveLength(1)
    })

    it('refuses a plan the parent has no room for, whole', async () => {
      const h = makeHarness()
      await parentWith(h, 23)
      const before = h.board.taskCount()
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent(
          'r2',
          '<plan><step to="@Design Boo">a</step><step to="@Test Boo">b</step></plan>',
        ),
      )
      expect(h.board.taskCount()).toBe(before)
    })

    it('tells the sender of a capped hand-off once, across the turns it starts', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await parentWith(h, 24)
      await h.orchestrator.onEvent(sk('a2'), tool('r2', 'one more', 'Design Boo'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await h.orchestrator.onEvent(sk('a2'), tool('r3', 'one more', 'Design Boo'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(outbox.unsettledFor('a2')).toHaveLength(1)
    })

    it('tells the sender of a refused plan once, across the turns it starts', async () => {
      const { delivered, orchestrator } = makeHarness()
      const steps = Array.from(
        { length: MAX_PLAN_STEPS + 1 },
        (_, i) => `<step to="@Bug Boo">step ${i}</step>`,
      )
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', `<plan>${steps.join('')}</plan>`))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', `<plan>${steps.join('')}</plan>`))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).filter((r) => /Plan not started/.test(r.task))).toHaveLength(1)
    })

    it('holds top-level hand-offs to the same rate as other top-level creates', async () => {
      const capHits: CapHit[] = []
      const { board, delivered, orchestrator } = makeHarness({ onCapHit: (i) => capHits.push(i) })
      for (let i = 0; i < 30; i += 1) await board.createTask({ title: `root ${i}`, teamId: 't1' })
      const before = board.taskCount()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">more</delegate>'),
      )
      expect(board.taskCount()).toBe(before)
      expect(deliveredTo(delivered, 'a2')).toEqual([])
      expect(capHits.map((c) => c.kind)).toEqual(['root_rate_cap'])
    })
  })

  describe('createBoardOrchestrator: a team that asks before a plan starts', () => {
    const PLAN =
      '<plan><step to="@Bug Boo">run the tests</step><step to="@Design Boo">fix what fails</step></plan>'
    const asking = (opts?: HarnessOpts) => {
      const h = makeHarness(opts)
      h.board.setPlanApproval(true)
      return h
    }

    it('switch off: a plan starts at once, as it always did', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      expect(board.taskCount()).toBe(2)
      expect(board.waitingPlans()).toEqual([])
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
    })

    it('switch on: a lead’s plan makes no step and starts nothing until a person says so', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const waiting = board.waitingPlans()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.steps).toEqual(['run the tests', 'fix what fails'])
      // Only the card holding the plan, and it is waiting.
      expect(board.taskCount()).toBe(1)
      expect(board.statusOf(waiting[0]!.taskId)).toBe('blocked')
      expect(delivered).toEqual([])
    })

    it('tells the board the card holding the plan exists', async () => {
      const { board, changes, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const taskId = board.waitingPlans()[0]!.taskId
      expect(changes.some((c) => c.id === taskId && c.status === 'blocked')).toBe(true)
    })

    it('a plan re-issued while one waits stacks nothing', async () => {
      const { board, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', PLAN))
      expect(board.waitingPlans()).toHaveLength(1)
      expect(board.taskCount()).toBe(1)
    })

    it('a changed plan while one waits takes its place, on the same card', async () => {
      const { board, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const first = board.waitingPlans()[0]!
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<plan><step to="@Bug Boo">only this</step></plan>'),
      )
      const waiting = board.waitingPlans()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]!.taskId).toBe(first.taskId)
      expect(waiting[0]!.steps).toEqual(['only this'])
      expect(board.answerPlan(first.questionId, { accepted: true }).ok).toBe(false)
      expect(board.taskCount()).toBe(1)
    })

    it('accepting creates the steps once and fires the first, across a restart', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const { questionId } = board.waitingPlans()[0]!
      const before = board.taskCount()
      const accepted = board.answerPlan(questionId, { accepted: true })
      expect(accepted).toMatchObject({ ok: true, created: 2 })
      expect(board.taskCount()).toBe(before + 2)
      const twice = board.answerPlan(questionId, { accepted: true })
      expect(twice).toMatchObject({ ok: false, created: 0 })
      expect(board.taskCount()).toBe(before + 2)

      await orchestrator.resume()
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
      expect(deliveredTo(delivered, 'a2')[0]).toMatch(/run the tests/)
      expect(deliveredTo(delivered, 'a3')).toEqual([])

      // The next engine, after a restart, neither repeats the step nor loses the chain.
      const next = makeHarness({ board })
      await next.orchestrator.resume()
      expect(deliveredTo(next.delivered, 'a2')).toEqual([])
      await next.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'tests ran'))
      expect(deliveredTo(next.delivered, 'a3')).toHaveLength(1)
      expect(board.taskCount()).toBe(before + 2)
    })

    it('a replay of the accepted turn asks nothing new, on any engine', async () => {
      const { board, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      board.answerPlan(board.waitingPlans()[0]!.questionId, { accepted: true })
      const count = board.taskCount()
      const next = makeHarness({ board })
      await next.orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      expect(board.waitingPlans()).toEqual([])
      expect(board.taskCount()).toBe(count)
    })

    it('turning it down creates nothing', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const { questionId } = board.waitingPlans()[0]!
      expect(board.answerPlan(questionId, { accepted: false, note: 'Too much' })).toMatchObject({
        ok: true,
        created: 0,
      })
      await orchestrator.resume()
      expect(board.taskCount()).toBe(1)
      expect(deliveredTo(delivered, 'a2')).toEqual([])
      expect(deliveredTo(delivered, 'a3')).toEqual([])
    })

    it('more than the most steps is refused whole, and no one is asked', async () => {
      const { board, delivered, orchestrator } = asking()
      const steps = Array.from(
        { length: MAX_PLAN_STEPS + 1 },
        (_, i) => `<step to="@Bug Boo">step ${i}</step>`,
      )
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', `<plan>${steps.join('')}</plan>`))
      expect(board.taskCount()).toBe(0)
      expect(board.waitingPlans()).toEqual([])
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).some((r) => /Plan not started/.test(r.task))).toBe(true)
    })

    it('a worker’s plan keeps its task open and waiting, and its delegator hears', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      const parent = idsOf(board)[0]!
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', `I propose this. ${PLAN.replace(/@Bug Boo/, '@Test Boo')}`),
      )
      expect(board.statusOf(parent)).toBe('blocked')
      const waiting = board.waitingPlans()
      expect(waiting.map((w) => w.taskId)).toEqual([parent])
      expect(board.taskCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).filter((r) => r.sessionKey === sk('leader'))).toHaveLength(1)
      // Accepted, the steps hang under the task, and go to the agents the plan named.
      expect(board.answerPlan(waiting[0]!.questionId, { accepted: true }).created).toBe(2)
      await orchestrator.resume()
      expect(deliveredTo(delivered, 'a4')).toHaveLength(1)
    })

    it('switch off: a worker’s plan starts at once, and its task waits for the steps', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      const parent = idsOf(board)[0]!
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', PLAN.replace(/@Bug Boo/, '@Test Boo')))
      expect(board.statusOf(parent)).toBe('blocked')
      expect((await board.getTask(parent))!.task['waitingOn']).toContain('subtasks')
      expect(deliveredTo(delivered, 'a4')).toHaveLength(1)
      expect(board.waitingPlans()).toEqual([])
    })

    it('a plan on its own card under a waiting task does not keep that task waiting', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      const parent = idsOf(board)[0]!
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">part a</delegate>'),
      )
      expect(board.statusOf(parent)).toBe('blocked')
      // A follow-up run about that task asks about a plan: it waits on a card of its own.
      await orchestrator.onEvent(sk('a2'), doneEvent('r3', PLAN.replace(/@Bug Boo/, '@Test Boo')), {
        reportForTaskId: parent,
        stopGen: 0,
      })
      const [waiting] = board.waitingPlans()
      expect(waiting!.taskId).not.toBe(parent)
      expect(board.statusOf(waiting!.taskId)).toBe('blocked')
      // The work it handed out finishes. The card is not work handed out, so the wait is over
      // and its agent runs. It does not sit behind a person answering about something else.
      await orchestrator.onEvent(sk('a3'), doneEvent('r4', 'part a result'))
      await vi.advanceTimersByTimeAsync(0)
      expect(deliveredTo(delivered, 'a2').length).toBeGreaterThan(1)
      expect(board.statusOf(waiting!.taskId)).toBe('blocked')
    })

    it('a Stop closes the card and keeps the task waiting behind it from starting', async () => {
      let gen = 0
      const { board, delivered, orchestrator } = asking({ stopGen: () => gen })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      const parent = idsOf(board)[0]!
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">part a</delegate>'),
      )
      await orchestrator.onEvent(sk('a2'), doneEvent('r3', PLAN.replace(/@Bug Boo/, '@Test Boo')), {
        reportForTaskId: parent,
        stopGen: 0,
      })
      const card = board.waitingPlans()[0]!.taskId
      const toWorker = deliveredTo(delivered, 'a2').length
      gen = 1
      await orchestrator.markStopped()
      expect(board.statusOf(card)).toBe('cancelled')
      expect(board.waitingPlans()).toEqual([])
      expect(board.statusOf(parent)).toBe('todo')
      await orchestrator.resume()
      await vi.advanceTimersByTimeAsync(0)
      expect(deliveredTo(delivered, 'a2')).toHaveLength(toWorker)
    })

    it('a run a Stop overtook proposes nothing', async () => {
      let gen = 0
      const { board, orchestrator } = asking({ stopGen: () => gen })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      gen = 1
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', PLAN.replace(/@Bug Boo/, '@Test Boo')), {
        reportForTaskId: null,
        stopGen: 0,
      })
      expect(board.waitingPlans()).toEqual([])
    })

    it('a card that only holds a plan closes with its answer, and nothing runs on it', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const { questionId, taskId } = board.waitingPlans()[0]!
      board.answerPlan(questionId, { accepted: true })
      expect(board.statusOf(taskId)).toBe('done')
      await orchestrator.resume()
      expect(deliveredTo(delivered, 'leader')).toEqual([])
    })

    it('turned down, its card is cancelled, and nothing runs on it', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const { questionId, taskId } = board.waitingPlans()[0]!
      board.answerPlan(questionId, { accepted: false, note: 'Too much' })
      expect(board.statusOf(taskId)).toBe('cancelled')
      await orchestrator.resume()
      expect(delivered).toEqual([])
    })

    it('the switch goes off and the plan starts anyway: the waiting one cannot run it twice', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const { questionId, taskId } = board.waitingPlans()[0]!
      board.setPlanApproval(false)
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', PLAN))
      expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
      expect(board.waitingPlans()).toEqual([])
      expect(board.statusOf(taskId)).toBe('cancelled')
      const count = board.taskCount()
      expect(board.answerPlan(questionId, { accepted: true })).toMatchObject({
        ok: false,
        created: 0,
      })
      expect(board.taskCount()).toBe(count)
    })

    it('the same plan from a later turn, once accepted, makes nothing and says so', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      board.answerPlan(board.waitingPlans()[0]!.questionId, { accepted: true })
      const count = board.taskCount()
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', PLAN))
      expect(board.waitingPlans()).toEqual([])
      expect(board.taskCount()).toBe(count)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).some((r) => /already accepted/.test(r.task))).toBe(true)
    })

    it('the same plan from a later turn, once turned down, makes nothing and says so', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      board.answerPlan(board.waitingPlans()[0]!.questionId, { accepted: false })
      await orchestrator.onEvent(sk('leader'), doneEvent('r2', PLAN))
      expect(board.waitingPlans()).toEqual([])
      expect(board.taskCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered).some((r) => /turned these same steps down/.test(r.task))).toBe(
        true,
      )
    })

    it('a plan that takes another’s place is said in the chat, and starts no run', async () => {
      const { board, delivered, narrations, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<plan><step to="@Bug Boo">only this</step></plan>'),
      )
      expect(board.waitingPlans()).toHaveLength(1)
      expect(narrations.some((n) => /took the place/.test(n.text))).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(delivered).toEqual([])
    })

    it('a step too long to read is refused without pointing at a tool the run may not have', async () => {
      const { board, delivered, orchestrator } = asking()
      const long = 'x'.repeat(4_001)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', `<plan><step to="@Bug Boo">${long}</step></plan>`),
      )
      expect(board.taskCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const said = reflections(delivered)
        .map((r) => r.task)
        .join()
      expect(said).toMatch(/too long/)
      expect(said).not.toMatch(/write_plan/)
    })

    describe('a batch of hand-off tags', () => {
      const BATCH =
        '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate><delegate to="@Test Boo">c</delegate>'

      it('waits for a person as one question, and starts nothing', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        const waiting = board.waitingPlans()
        expect(waiting).toHaveLength(1)
        expect(waiting[0]!.steps).toEqual(['a', 'b', 'c'])
        expect(board.taskCount()).toBe(1)
        expect(delivered).toEqual([])
      })

      it('accepted, all of it starts at once', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        expect(
          board.answerPlan(board.waitingPlans()[0]!.questionId, { accepted: true }).created,
        ).toBe(3)
        await orchestrator.resume()
        expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
        expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
        expect(deliveredTo(delivered, 'a4')).toHaveLength(1)
      })

      it('turned down, none of it starts', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        board.answerPlan(board.waitingPlans()[0]!.questionId, { accepted: false })
        await orchestrator.resume()
        expect(delivered).toEqual([])
      })

      it('seen again waits as it was', async () => {
        const { board, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        await orchestrator.onEvent(sk('leader'), doneEvent('r2', BATCH))
        expect(board.waitingPlans()).toHaveLength(1)
        expect(board.taskCount()).toBe(1)
      })

      it('holds to the turn’s cap, and says what it left out', async () => {
        const capHits: CapHit[] = []
        const { board, delivered, orchestrator } = asking({
          caps: { maxFanout: 2 },
          onCapHit: (i) => capHits.push(i),
        })
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        expect(board.waitingPlans()[0]!.steps).toEqual(['a', 'b'])
        expect(capHits.map((c) => c.kind)).toEqual(['fanout'])
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered).some((r) => /Fan-out cap/.test(r.task))).toBe(true)
      })

      it('from a worker keeps its task open and waiting', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
        )
        const parent = idsOf(board)[0]!
        delivered.length = 0
        await orchestrator.onEvent(
          sk('a2'),
          doneEvent(
            'r2',
            '<delegate to="@Design Boo">x</delegate><delegate to="@Test Boo">y</delegate>',
          ),
        )
        expect(board.statusOf(parent)).toBe('blocked')
        expect(board.waitingPlans().map((w) => w.taskId)).toEqual([parent])
        expect(deliveredTo(delivered, 'a3')).toEqual([])
        expect(deliveredTo(delivered, 'a4')).toEqual([])
      })

      it('the switch goes off and the batch starts anyway: the waiting one cannot run it twice', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        const { questionId, taskId } = board.waitingPlans()[0]!
        board.setPlanApproval(false)
        await orchestrator.onEvent(sk('leader'), doneEvent('r2', BATCH))
        expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
        expect(board.waitingPlans()).toEqual([])
        expect(board.statusOf(taskId)).toBe('cancelled')
        expect(board.answerPlan(questionId, { accepted: true })).toMatchObject({
          ok: false,
          created: 0,
        })
      })

      it('one hand-off tag still goes straight through', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">one</delegate>'),
        )
        expect(board.waitingPlans()).toEqual([])
        expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
      })

      it('hand-offs by tool call go out one at a time, as they arrive', async () => {
        const { board, delivered, orchestrator } = asking()
        const tool = (task: string, assignee: string): RuntimeEvent =>
          toolCallEvent('r1', 'team_delegate', { assignee, task })
        await orchestrator.onEvent(sk('leader'), tool('one', 'Bug Boo'))
        await orchestrator.onEvent(sk('leader'), tool('two', 'Design Boo'))
        expect(board.waitingPlans()).toEqual([])
        expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
        expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
      })

      it('switch off: all of it starts at once, as it always did', async () => {
        const { board, delivered, orchestrator } = makeHarness()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', BATCH))
        expect(board.waitingPlans()).toEqual([])
        expect(board.taskCount()).toBe(3)
        expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
        expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
      })
    })

    it('a Stop while the plan’s checks run proposes nothing', async () => {
      let gen = 0
      const { board, orchestrator } = asking({ stopGen: () => gen })
      const room = board.handOffRoom.bind(board)
      board.handOffRoom = async (...args) => {
        gen = 1
        return room(...args)
      }
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      expect(board.waitingPlans()).toEqual([])
      expect(board.taskCount()).toBe(0)
    })

    it('a Stop closes what waits: nothing starts, and accepting it then does nothing', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN))
      const { questionId, taskId } = board.waitingPlans()[0]!
      await orchestrator.markStopped()
      expect(board.waitingPlans()).toEqual([])
      expect(board.statusOf(taskId)).toBe('cancelled')
      expect(board.answerPlan(questionId, { accepted: true })).toMatchObject({
        ok: false,
        created: 0,
      })
      await orchestrator.resume()
      expect(delivered).toEqual([])
    })

    it('a Stop sends a worker’s waiting task back as stopped, and the pump leaves it', async () => {
      const { board, delivered, orchestrator } = asking()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">parent</delegate>'),
      )
      const parent = idsOf(board)[0]!
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', PLAN.replace(/@Bug Boo/, '@Test Boo')))
      delivered.length = 0
      await orchestrator.markStopped()
      expect(board.statusOf(parent)).toBe('todo')
      await orchestrator.resume()
      expect(deliveredTo(delivered, 'a2')).toEqual([])
    })
  })

  // ─── A person's request: the main task ─────────────────────────────────────
  describe("createBoardOrchestrator: a person's request is one main task", () => {
    const PERSON = { id: 'p1', name: 'Pat', role: null }
    const asked = (deliveryId: string, words = 'Build the login page'): RunStamp => ({
      reportForTaskId: null,
      stopGen: 0,
      deliveryId,
      request: { words, requestedBy: PERSON },
    })
    /** The stamp the host puts on an update it delivers. */
    const updateRun = (d: Delivered, deliveryId: string): RunStamp => ({
      reportForTaskId: null,
      stopGen: 0,
      deliveryId,
      ...(d.origin.kind === 'system' && d.origin.mainTaskId
        ? { mainTaskId: d.origin.mainTaskId }
        : {}),
    })
    const parentOf = async (board: CascadeBoard, taskId: string): Promise<string> => {
      const d = await board.getTask(taskId)
      return d?.task.parentTaskId as string
    }
    const lastUpdate = (delivered: Delivered[]): Delivered => reflections(delivered).at(-1)!

    it('a plain answer creates no task', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(sk('leader'), doneEvent('r1', 'Sure, it is 4.'), asked('d1'))
      expect(board.taskCount()).toBe(0)
      expect(delivered).toEqual([])
    })

    it('makes one main task from the first hand-off, and files the turn under it', async () => {
      const { board, delivered, changes, orchestrator } = makeHarness()
      const run = asked('d1', 'Build the login page\nwith a reset link')
      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r1', 'delegate', { assignee: 'Bug Boo', task: 'write the form' }),
        run,
      )
      expect(board.taskCount()).toBe(2)
      const [first] = idsOf(board)
      const mainId = await parentOf(board, first!)
      const state = (await board.mainTaskState(mainId))!
      expect(state).toMatchObject({
        title: 'Build the login page',
        status: 'in_progress',
        leadAgentId: 'leader',
        open: true,
        openSubtasks: 1,
      })
      const detail = await board.getTask(mainId)
      expect(detail?.task.description).toBe('Build the login page\nwith a reset link')
      expect(detail?.ancestors).toEqual([])
      // Announced, so a chat and a board can show it.
      expect(changes.find((c) => c.id === mainId)).toMatchObject({
        isMainTask: true,
        status: 'in_progress',
      })

      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Design Boo">style it</delegate>'),
        run,
      )
      expect(board.taskCount()).toBe(3)
      const [, second] = idsOf(board)
      expect(await parentOf(board, second!)).toBe(mainId)
      expect(deliveredTo(delivered, 'a2')).toEqual(['write the form'])
      expect(deliveredTo(delivered, 'a3')).toEqual(['style it'])
    })

    it('files every step of a plan under it, in order', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<plan><step to="@Bug Boo">one</step><step to="@Design Boo">two</step></plan>',
        ),
        asked('d1'),
      )
      const [one, two] = idsOf(board)
      const mainId = await parentOf(board, one!)
      expect(await parentOf(board, two!)).toBe(mainId)
      expect(board.depsOf(two!)).toEqual([one])
      expect((await board.mainTaskState(mainId))?.openSubtasks).toBe(2)
    })

    it('a hand-off that finds its work open makes no main task', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">write the form</delegate>'),
        asked('d1'),
      )
      expect(board.taskCount()).toBe(2)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<delegate to="@Bug Boo">write the form</delegate>'),
        asked('d2', 'Are you on the form?'),
      )
      expect(board.taskCount()).toBe(2)
    })

    it('a second message in the chat makes its own main task', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">one</delegate>'),
        asked('d1'),
      )
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<delegate to="@Design Boo">two</delegate>'),
        asked('d2', 'Clean the logs'),
      )
      const [one, two] = idsOf(board)
      expect(await parentOf(board, one!)).not.toBe(await parentOf(board, two!))
    })

    it('leaves helpers every level of hand-offs they had', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">b</delegate>'),
      )
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', '<delegate to="@Test Boo">c</delegate>'))
      // The main task and three levels below it, as with no main task at all.
      expect(board.taskCount()).toBe(4)
      const [, , deepest] = idsOf(board)
      await orchestrator.onEvent(sk('a4'), doneEvent('r4', '<delegate to="@Boo Zero">d</delegate>'))
      expect(board.taskCount()).toBe(4)
      expect(board.comments.some((c) => c.taskId === deepest && /depth limit/i.test(c.body))).toBe(
        true,
      )
    })

    it('holds the refusal latch at the limit under a request: said once, and the task still ends', async () => {
      const outbox = new MemoryReportUps()
      const { board, delivered, orchestrator } = makeHarness({ reportUps: outbox })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', '<delegate to="@Design Boo">b</delegate>'),
      )
      await orchestrator.onEvent(sk('a3'), doneEvent('r3', '<delegate to="@Test Boo">c</delegate>'))
      const deepest = idsOf(board)[2]!
      const count = board.taskCount()
      const again = '<delegate to="@Boo Zero">one level too far</delegate>'
      await orchestrator.onEvent(sk('a4'), doneEvent('r4', `Not done. ${again}`))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // It hears the refusal on its next run, once, and repeating it says nothing new.
      const turns = delivered.filter((d) => d.agentId === 'a4' && (d.context ?? '').length > 0)
      expect(turns).toHaveLength(1)
      await orchestrator.onEvent(sk('a4'), doneEvent('r5', `Still. ${again}`), {
        reportForTaskId: null,
        stopGen: 0,
        deliveryId: 'r5',
        reportUpIds: turns[0]!.reportUpIds ?? [],
      })
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(
        delivered.filter((d) => d.agentId === 'a4' && (d.context ?? '').length > 0),
      ).toHaveLength(1)
      expect(board.statusOf(deepest)).toBe('done')
      expect(board.taskCount()).toBe(count)
    })

    it('never fires a main task: no pump, resume, sweep or dispatch', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await orchestrator.resume()
      await orchestrator.sweepStaleSessions()
      expect(await orchestrator.dispatchTask(mainId)).toBe('not_ready')
      expect(board.claims).not.toContain(mainId)
      expect(await board.listExecutions(mainId)).toEqual([])
      expect(delivered.map((d) => d.task)).not.toContain('Build the login page')
      expect((await board.getReadyTasks('t1')).map((t) => t.id)).not.toContain(mainId)
      // And no idle clock fails it: it has no run to go silent.
      await vi.advanceTimersByTimeAsync(2 * DELEGATION_IDLE_TIMEOUT_MS)
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(mainId)).toBe('in_progress')
    })

    it("is done only after the last sub-task and the lead's summary", async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
        ),
        asked('d1'),
      )
      const [a] = idsOf(board)
      const mainId = await parentOf(board, a!)

      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const first = lastUpdate(delivered)
      expect(first.origin).toMatchObject({ kind: 'system', mainTaskId: mainId })
      expect(first.task).toContain('Build the login page')
      expect(first.task).not.toMatch(/closes the request/)
      await orchestrator.onEvent(sk('leader'), doneEvent('ru1', 'A is in.'), updateRun(first, 'u1'))
      expect(board.statusOf(mainId)).toBe('in_progress')

      await orchestrator.onEvent(sk('a3'), doneEvent('rb', 'B is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const last = lastUpdate(delivered)
      expect(last.task).toMatch(/closes the request/)
      expect(board.statusOf(mainId)).toBe('in_progress')
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru2', 'Here is the login page.'),
        updateRun(last, 'u2'),
      )
      expect(board.statusOf(mainId)).toBe('done')
      expect(
        board.comments.some((c) => c.taskId === mainId && c.body === 'Here is the login page.'),
      ).toBe(true)
    })

    it('stays open when the summary turn hands out more, filed under it', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru1', 'One more thing. <delegate to="@Design Boo">polish</delegate>'),
        updateRun(lastUpdate(delivered), 'u1'),
      )
      expect(board.statusOf(mainId)).toBe('in_progress')
      expect(await parentOf(board, idsOf(board)[1]!)).toBe(mainId)
    })

    it('keeps each request to its own update, and an unfinished one stays open', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">one</delegate>'),
        asked('d1'),
      )
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<delegate to="@Design Boo">two</delegate>'),
        asked('d2', 'Clean the logs'),
      )
      const [one, two] = idsOf(board)
      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'one is done'))
      await orchestrator.onEvent(sk('a3'), doneEvent('rb', 'two is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const updates = reflections(delivered)
      expect(updates).toHaveLength(2)
      const mains = updates.map((u) => (u.origin as { mainTaskId?: string }).mainTaskId)
      expect(new Set(mains)).toEqual(
        new Set([await parentOf(board, one!), await parentOf(board, two!)]),
      )
    })

    it('counts a sub-task still open under a finished one', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const [childId] = idsOf(board)
      const mainId = await parentOf(board, childId!)
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('ra', 'A so far <delegate to="@Design Boo">deeper</delegate>'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // The sub-task waits for what it handed out, so its lead has nothing to read yet.
      expect(board.statusOf(childId!)).toBe('blocked')
      expect(reflections(delivered)).toHaveLength(0)
      // A person finishes it by hand, with the work under it still going: its report
      // reaches the lead, and the update says what is still out.
      await board.updateStatus(childId!, 'in_progress')
      await board.updateStatus(childId!, 'done')
      expect((await board.mainTaskState(mainId))?.openSubtasks).toBe(1)
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(mainId)).toBe('in_progress')
    })

    it('waits for a sub-task that handed out work, and closes on the one summary after it', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const [childId] = idsOf(board)
      const mainId = await parentOf(board, childId!)
      await orchestrator.onEvent(
        sk('a2'),
        doneEvent('ra', 'A so far <delegate to="@Design Boo">deeper</delegate>'),
      )
      await orchestrator.onEvent(sk('a3'), doneEvent('rb', 'Deeper is done.'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.sweepStaleSessions()
      // The grandchild reports to the sub-task, not to the lead: the sub-task's own
      // follow-up is what the lead hears.
      expect(reflections(delivered)).toHaveLength(0)
      expect(deliveredTo(delivered, 'a2').length).toBeGreaterThan(0)
      await orchestrator.onEvent(sk('a2'), doneEvent('rc', 'A is done.'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.statusOf(childId!)).toBe('done')
      const updates = reflections(delivered)
      expect(updates).toHaveLength(1)
      expect((updates[0]!.origin as { mainTaskId?: string }).mainTaskId).toBe(mainId)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru', 'All done.'),
        updateRun(updates[0]!, 'u1'),
      )
      expect(board.statusOf(mainId)).toBe('done')
    })

    it('makes a routine run its own main task, with no person named', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">sweep logs</delegate>'),
        {
          reportForTaskId: null,
          stopGen: 0,
          deliveryId: 'd1',
          request: { words: 'Sweep the logs', routineName: 'Nightly' },
        },
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      expect((await board.mainTaskState(mainId))?.title).toBe('Sweep the logs')
      expect(board.comments.some((c) => c.taskId === mainId && /Nightly/.test(c.body))).toBe(true)
    })

    it('makes no main task for a hand-off with no message behind it', async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        { reportForTaskId: null, stopGen: 0, deliveryId: 'd1' },
      )
      expect(board.taskCount()).toBe(1)
      expect((await board.getTask(idsOf(board)[0]!))?.task.parentTaskId).toBeNull()
    })

    it('a person closing the request ends its reports, and refuses more work under it', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await board.closeMainTask(mainId, 'cancelled')
      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('rx', '<delegate to="@Design Boo">more</delegate>'),
        { reportForTaskId: null, stopGen: 0, deliveryId: 'd9', mainTaskId: mainId },
      )
      expect(deliveredTo(delivered, 'a3')).toEqual([])
    })

    it('a Stop leaves the request open, and starts no summary', async () => {
      let gen = 0
      const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      gen += 1
      await orchestrator.markStopped()
      await orchestrator.onEvent(sk('a2'), failedDoneEvent('ra', 'aborted', ''))
      await orchestrator.resume()
      await orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.statusOf(mainId)).toBe('in_progress')
      expect(reflections(delivered)).toEqual([])
    })

    it('asks the lead once when its work closed with nothing left to report', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const [a] = idsOf(board)
      const mainId = await parentOf(board, a!)
      // Closed outside the engine: an MCP write in another process reports to no one.
      await orchestrator.detachTask(a!)
      await board.updateStatus(a!, 'done')
      await orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const updates = reflections(delivered)
      expect(updates).toHaveLength(1)
      expect(updates[0]!.task).toMatch(/closes the request/)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru', 'It is done.'),
        updateRun(updates[0]!, 'u1'),
      )
      expect(board.statusOf(mainId)).toBe('done')
    })

    it("a person's comment reaches the lead, and what it hands out is filed under it", async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      expect(await orchestrator.personCommentedOnMainTask(mainId, 'Add a logo too')).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const update = lastUpdate(delivered)
      expect(update.agentId).toBe('leader')
      expect(update.task).toContain('Add a logo too')
      expect(update.origin).toMatchObject({ kind: 'system', mainTaskId: mainId })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru', '<delegate to="@Design Boo">add a logo</delegate>'),
        updateRun(update, 'u1'),
      )
      expect(await parentOf(board, idsOf(board)[1]!)).toBe(mainId)
      expect(board.statusOf(mainId)).toBe('in_progress')
    })

    it("a person's comment goes at the job's limit, and counts nothing", async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      const count = board.jobRunsOf(mainId)
      board.seedJobRuns(mainId, count)
      expect(await orchestrator.personCommentedOnMainTask(mainId, 'Add a logo too')).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(lastUpdate(delivered).task).toContain('Add a logo too')
      expect(board.jobRunsOf(mainId)).toBe(count)
    })

    it("a person's comment counts nothing with room left either", async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      const count = board.jobRunsOf(mainId)
      expect(await orchestrator.personCommentedOnMainTask(mainId, 'Add a logo too')).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(lastUpdate(delivered).task).toContain('Add a logo too')
      expect(lastUpdate(delivered).origin).not.toHaveProperty('countJobs')
      expect(board.jobRunsOf(mainId)).toBe(count)
    })

    it("a person's comment starts work again in a job they stopped", async () => {
      const { board, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      board.seedJobRuns(mainId, board.jobRunsOf(mainId))
      board.seedJobStopped(mainId)
      expect(board.jobIsStopped(mainId)).toBe(true)
      expect(await orchestrator.personCommentedOnMainTask(mainId, 'Go on')).toBe(true)
      expect(board.jobIsStopped(mainId)).toBe(false)
    })

    it('a comment on a closed request goes nowhere', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await board.closeMainTask(mainId, 'cancelled')
      expect(await orchestrator.personCommentedOnMainTask(mainId, 'hello')).toBe(false)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
    })

    it('a control token is not a summary: nothing goes on the card but a note', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru', '__skipped__'),
        updateRun(lastUpdate(delivered), 'u1'),
      )
      expect(board.statusOf(mainId)).toBe('done')
      const onCard = board.comments.filter((c) => c.taskId === mainId).map((c) => c.body)
      expect(onCard.some((b) => b.includes('__skipped__'))).toBe(false)
      expect(onCard.some((b) => /no summary/.test(b))).toBe(true)
    })

    it('keeps a hand-off tag out of the summary on the card', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r2', '<delegate to="@Design Boo">other work</delegate>'),
        asked('d2', 'Other work'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // A hand-off in its closing turn finds the other request's open work. The lead is
      // told once, and repeating it in the next turn is silent.
      const repeat = '<delegate to="@Design Boo">other work</delegate>'
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru', `Not yet. ${repeat}`),
        updateRun(lastUpdate(delivered), 'u1'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru2', `All done. ${repeat}`),
        updateRun(lastUpdate(delivered), 'u2'),
      )
      expect(board.statusOf(mainId)).toBe('done')
      expect(board.comments.filter((c) => c.taskId === mainId).map((c) => c.body)).toContain(
        'All done.',
      )
    })

    const held = (): {
      resolve: (r: DelegationResolution) => void
      opts: Pick<HarnessOpts, 'isRiskyDelegation' | 'requestDelegationApproval'>
    } => {
      let resolve: (r: DelegationResolution) => void = () => undefined
      const answer = new Promise<DelegationResolution>((r) => {
        resolve = r
      })
      return {
        resolve: (r) => resolve(r),
        opts: {
          isRiskyDelegation: (s) => s.task.startsWith('risky'),
          requestDelegationApproval: () => answer,
        },
      }
    }

    it('a hand-off waiting on a person’s approval holds the request open', async () => {
      const approval = held()
      const { board, delivered, orchestrator } = makeHarness(approval.opts)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const update = lastUpdate(delivered)
      const closing = orchestrator.onEvent(
        sk('leader'),
        doneEvent('ru', 'One more. <delegate to="@Design Boo">risky step</delegate>'),
        updateRun(update, 'u1'),
      )
      await vi.advanceTimersByTimeAsync(0)
      await orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(board.statusOf(mainId)).toBe('in_progress')
      expect(reflections(delivered)).toEqual([update])
      approval.resolve('allow_once')
      await closing
      expect(board.statusOf(mainId)).toBe('in_progress')
      const made = idsOf(board).at(-1)!
      expect(await parentOf(board, made)).toBe(mainId)
      expect(deliveredTo(delivered, 'a3')).toEqual(['risky step'])
    })

    it('a sub-task’s own hand-off holds it too, and starts nothing once it closed', async () => {
      const approval = held()
      const { board, delivered, orchestrator } = makeHarness(approval.opts)
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const [a] = idsOf(board)
      const mainId = await parentOf(board, a!)
      const before = board.taskCount()
      const ending = orchestrator.onEvent(
        sk('a2'),
        doneEvent('ra', 'Mine is done. <delegate to="@Design Boo">risky step</delegate>'),
      )
      await vi.advanceTimersByTimeAsync(0)
      await orchestrator.sweepStaleSessions()
      expect(board.statusOf(mainId)).toBe('in_progress')
      // A person closes the request while the approval waits.
      await board.closeMainTask(mainId, 'cancelled')
      approval.resolve('allow_once')
      await ending
      expect(board.taskCount()).toBe(before)
      expect(deliveredTo(delivered, 'a3')).toEqual([])
      expect(board.comments.some((c) => /The person closed/.test(c.body))).toBe(false)
    })

    it('holds the depth and child caps under the main task for a plan', async () => {
      const { board, delivered, orchestrator } = makeHarness()
      const steps = Array.from(
        { length: MAX_PLAN_STEPS },
        (_, i) => `<step to="@Bug Boo">s${i}</step>`,
      )
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', `<plan>${steps.join('')}</plan>`),
        asked('d1'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      // Either the whole plan fits under one main task, or none of it starts.
      const made = idsOf(board)
      if (made.length > 0) {
        const mainId = await parentOf(board, made[0]!)
        expect((await board.mainTaskState(mainId))?.subtaskIds).toHaveLength(made.length)
      } else {
        expect(reflections(delivered).some((r) => /Plan not started/.test(r.task))).toBe(true)
      }
    })

    // ─── Where a request meets the rest of the board ──────────────────────────
    describe('and a team that asks before a plan starts', () => {
      const PLAN =
        '<plan><step to="@Bug Boo">run the tests</step><step to="@Design Boo">fix what fails</step></plan>'
      const asking = (opts?: HarnessOpts) => {
        const h = makeHarness(opts)
        h.board.setPlanApproval(true)
        return h
      }
      const stepsOf = async (board: CascadeBoard, mainId: string): Promise<BoardTask[]> =>
        (await board.listTasks('t1')).filter(
          (t) => t.parentTaskId === mainId && !isPlanHolder(t.sourceDelegationId as string),
        )

      it('files the card under the main task, made with it, and names the person', async () => {
        const { board, changes, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const { taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        expect(await board.mainTaskState(mainId)).toMatchObject({
          title: 'Build the login page',
          leadAgentId: 'leader',
          status: 'in_progress',
          openSubtasks: 1,
        })
        expect(board.taskCount()).toBe(2)
        expect(delivered).toEqual([])
        expect(changes.find((c) => c.id === mainId)).toMatchObject({ isMainTask: true })
        expect(changes.find((c) => c.id === taskId)).toMatchObject({ parentTaskId: mainId })
      })

      it('makes nothing when the plan is refused before anyone is asked', async () => {
        const { board, orchestrator } = asking()
        const steps = Array.from(
          { length: MAX_PLAN_STEPS + 1 },
          (_, i) => `<step to="@Bug Boo">step ${i}</step>`,
        )
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', `<plan>${steps.join('')}</plan>`),
          asked('d1'),
        )
        expect(board.taskCount()).toBe(0)
      })

      it('finds the same card for the same steps, with no second main task', async () => {
        const { board, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        await orchestrator.onEvent(sk('leader'), doneEvent('r2', PLAN), asked('d2'))
        expect(board.waitingPlans()).toHaveLength(1)
        expect(board.taskCount()).toBe(2)
      })

      it('a changed plan from a later message stays where the waiting one is', async () => {
        const { board, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const { taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r2', '<plan><step to="@Bug Boo">only this</step></plan>'),
          asked('d2', 'Actually just this'),
        )
        const waiting = board.waitingPlans()
        expect(waiting.map((w) => w.taskId)).toEqual([taskId])
        expect(board.taskCount()).toBe(2)
        expect(board.answerPlan(waiting[0]!.questionId, { accepted: true }).created).toBe(1)
        expect((await stepsOf(board, mainId)).map((t) => t.title)).toEqual(['only this'])
      })

      it('an open card holds the request: nothing closes it, and its lead is not asked', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const mainId = await parentOf(board, board.waitingPlans()[0]!.taskId)
        await orchestrator.resume()
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(board.statusOf(mainId)).toBe('in_progress')
        expect(reflections(delivered)).toEqual([])
        // A lead's turn about the request ending is no summary while it waits.
        await orchestrator.onEvent(sk('leader'), doneEvent('r2', 'Waiting.'), {
          reportForTaskId: null,
          stopGen: 0,
          deliveryId: 'u1',
          mainTaskId: mainId,
        })
        expect(board.statusOf(mainId)).toBe('in_progress')
      })

      it('accepted, the steps nest under the main task, and it closes on the summary after them', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const { questionId, taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        expect(board.answerPlan(questionId, { accepted: true }).created).toBe(2)
        const steps = await stepsOf(board, mainId)
        expect(steps.map((t) => t.title)).toEqual(['run the tests', 'fix what fails'])
        // The card is closed, and the steps took its place.
        expect(board.statusOf(taskId)).toBe('done')
        expect((await board.mainTaskState(mainId))?.openSubtasks).toBe(2)

        await orchestrator.resume()
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'tests ran'))
        await orchestrator.onEvent(sk('a3'), doneEvent('r3', 'fixed'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(board.statusOf(mainId)).toBe('in_progress')
        const update = lastUpdate(delivered)
        expect((update.origin as { mainTaskId?: string }).mainTaskId).toBe(mainId)
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('ru', 'It works.'),
          updateRun(update, 'u'),
        )
        expect(board.statusOf(mainId)).toBe('done')
      })

      it('turned down, it closes as Cancelled: a card that held a plan is no work done', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const { questionId, taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        board.answerPlan(questionId, { accepted: false, note: 'Too much' })
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(board.statusOf(mainId)).toBe('in_progress')
        const update = lastUpdate(delivered)
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('ru', 'Understood.'),
          updateRun(update, 'u'),
        )
        expect(board.statusOf(mainId)).toBe('cancelled')
      })

      it('accepted and then all cancelled, it does not read as Done on the card alone', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const { questionId, taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        board.answerPlan(questionId, { accepted: true })
        for (const step of await stepsOf(board, mainId))
          await board.updateStatus(step.id, 'cancelled')
        expect(await board.mainTaskState(mainId)).toMatchObject({
          openSubtasks: 0,
          doneSubtasks: 0,
        })
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('ru', 'Nothing came of it.'),
          updateRun(lastUpdate(delivered), 'u'),
        )
        expect(board.statusOf(mainId)).toBe('cancelled')
      })

      it('a batch of tags waits on a card under the main task, and starts together', async () => {
        const { board, delivered, orchestrator } = asking()
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent(
            'r1',
            '<delegate to="@Bug Boo">a</delegate><delegate to="@Design Boo">b</delegate>',
          ),
          asked('d1'),
        )
        expect(delivered).toEqual([])
        const { questionId, taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        expect((await board.mainTaskState(mainId))?.title).toBe('Build the login page')
        expect(board.answerPlan(questionId, { accepted: true }).created).toBe(2)
        expect((await stepsOf(board, mainId)).map((t) => t.title)).toEqual(['a', 'b'])
        await orchestrator.resume()
        expect(deliveredTo(delivered, 'a2')).toHaveLength(1)
        expect(deliveredTo(delivered, 'a3')).toHaveLength(1)
      })

      it('a Stop closes the card and starts no lead run, however long its close took', async () => {
        const outbox = new MemoryReportUps()
        const { board, delivered, orchestrator } = asking({ reportUps: outbox })
        await orchestrator.onEvent(sk('leader'), doneEvent('r1', PLAN), asked('d1'))
        const { taskId } = board.waitingPlans()[0]!
        const mainId = await parentOf(board, taskId)
        // The card closes after the Stop began, as a slow write would.
        const close = board.closeWaitingPlans!.bind(board)
        board.closeWaitingPlans = async (teamId) => {
          await vi.advanceTimersByTimeAsync(50)
          await close(teamId)
        }
        await orchestrator.markStopped()
        expect(board.statusOf(taskId)).toBe('cancelled')
        await vi.advanceTimersByTimeAsync(50)
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered)).toEqual([])
        expect(board.statusOf(mainId)).toBe('in_progress')
        expect(outbox.held().map((r) => r.item.outcome)).toEqual(['all_in'])
      })
    })

    describe('and work that waits for what it handed out', () => {
      it('a note about the request itself does not wait for a run it will never have', async () => {
        const outbox = new MemoryReportUps()
        const { board, delivered, orchestrator } = makeHarness({
          reportUps: outbox,
          sessionKeyForAgent: (id) => (id === 'a3' ? null : sk(id)),
        })
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const mainId = await parentOf(board, idsOf(board)[0]!)
        await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done.'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const first = lastUpdate(delivered)
        // The lead's update turn tries for someone it cannot reach. The note is about the
        // request, and only its lead can hear it.
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('ru', 'One more. <delegate to="@Design Boo">more</delegate>'),
          {
            ...updateRun(first, 'u1'),
            reportUpIds: (first.origin as { reportUpIds?: string[] }).reportUpIds ?? [],
          },
        )
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const note = lastUpdate(delivered)
        expect(note.task).toMatch(/Could not reach Design Boo/)
        expect((note.origin as { mainTaskId?: string }).mainTaskId).toBe(mainId)
        expect((note.origin as { forTaskId?: string }).forTaskId).toBeUndefined()
        await orchestrator.onEvent(sk('leader'), doneEvent('ru2', 'All done.'), {
          ...updateRun(note, 'u2'),
          reportUpIds: (note.origin as { reportUpIds?: string[] }).reportUpIds ?? [],
        })
        expect(board.statusOf(mainId)).toBe('done')
      })

      it('a lead that keeps asking for what is refused gets the same few turns', async () => {
        const { board, delivered, orchestrator } = makeHarness({
          sessionKeyForAgent: (id) => (id === 'a3' ? null : sk(id)),
        })
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const mainId = await parentOf(board, idsOf(board)[0]!)
        // The sub-task is still running, so no reply of the lead's closes the request.
        for (let i = 0; i < 6; i++) {
          await orchestrator.onEvent(
            sk('leader'),
            doneEvent(`u${i}`, `<delegate to="@Design Boo">more ${i}</delegate>`),
            { reportForTaskId: null, stopGen: 0, deliveryId: `u${i}`, mainTaskId: mainId },
          )
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        }
        expect(reflections(delivered).length).toBeLessThanOrEqual(MAX_REFUSAL_TURNS)
        expect(board.statusOf(mainId)).toBe('in_progress')
      })

      it('the lead does not wait on a sub-task’s report: it is an update, not a follow-up', async () => {
        const outbox = new MemoryReportUps()
        const { board, delivered, orchestrator } = makeHarness({ reportUps: outbox })
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const mainId = await parentOf(board, idsOf(board)[0]!)
        await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done.'))
        // Written with nothing to wait for: a main task has no next run to take it.
        const [row] = outbox.unsettledFor('leader')
        expect(row?.taskId).toBe(idsOf(board)[0])
        expect(row?.forTaskId).toBeUndefined()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const origin = lastUpdate(delivered).origin as { mainTaskId?: string; forTaskId?: string }
        expect(origin.mainTaskId).toBe(mainId)
        expect(origin.forTaskId).toBeUndefined()
      })

      it('a restart after the last sub-task closed still gets one closing turn', async () => {
        const outbox = new MemoryReportUps()
        const first = makeHarness({ reportUps: outbox })
        await first.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const mainId = await parentOf(first.board, idsOf(first.board)[0]!)
        await first.orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done.'))
        first.orchestrator.reset()
        const next = makeHarness({ board: first.board, reportUps: outbox })
        await next.orchestrator.resume()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        await next.orchestrator.resume()
        await next.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const updates = reflections(next.delivered)
        expect(updates).toHaveLength(1)
        await next.orchestrator.onEvent(sk('leader'), doneEvent('ru', 'Done.'), {
          ...updateRun(updates[0]!, 'u'),
          reportUpIds: (updates[0]!.origin as { reportUpIds?: string[] }).reportUpIds ?? [],
        })
        expect(first.board.statusOf(mainId)).toBe('done')
      })

      it('a lead’s run is no run of the request: nothing is claimed or opened on it', async () => {
        const { board, delivered, orchestrator } = makeHarness()
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const mainId = await parentOf(board, idsOf(board)[0]!)
        await orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done.'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('ru', 'Done.'),
          updateRun(lastUpdate(delivered), 'u'),
        )
        expect(board.statusOf(mainId)).toBe('done')
        expect(await ledgerOf(board, mainId)).toEqual([])
        expect(board.claims).not.toContain(mainId)
      })
    })

    describe('and how a run ends', () => {
      const oneSubTaskIn = async (opts?: HarnessOpts) => {
        const h = makeHarness(opts)
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const mainId = await parentOf(h.board, idsOf(h.board)[0]!)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('ra', 'A is done.'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        return { ...h, mainId, update: lastUpdate(h.delivered) }
      }

      it('a silent closing turn closes it with a note, and gets no extra turn', async () => {
        const { board, delivered, orchestrator, mainId, update } = await oneSubTaskIn()
        const count = delivered.length
        await orchestrator.onEvent(sk('leader'), doneEvent('ru', ''), updateRun(update, 'u'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(board.statusOf(mainId)).toBe('done')
        expect(board.comments.some((c) => c.taskId === mainId && /no summary/.test(c.body))).toBe(
          true,
        )
        expect(delivered).toHaveLength(count)
        expect(await ledgerOf(board, mainId)).toEqual([])
      })

      it('a control token reads as no summary too', async () => {
        const { board, orchestrator, mainId, update } = await oneSubTaskIn()
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('ru', 'NO_REPLY'),
          updateRun(update, 'u'),
        )
        expect(board.statusOf(mainId)).toBe('done')
        expect(board.comments.some((c) => c.taskId === mainId && c.body === 'NO_REPLY')).toBe(false)
      })

      it('a lead turn that fails closes nothing, and its report goes out again', async () => {
        const outbox = new MemoryReportUps()
        const { board, delivered, orchestrator, mainId, update } = await oneSubTaskIn({
          reportUps: outbox,
        })
        const carried = (update.origin as { reportUpIds?: string[] }).reportUpIds ?? []
        expect(carried.length).toBeGreaterThan(0)
        await orchestrator.onEvent(sk('leader'), failedDoneEvent('ru', 'error', 'boom'), {
          ...updateRun(update, 'u'),
          reportUpIds: carried,
        })
        expect(board.statusOf(mainId)).toBe('in_progress')
        const count = reflections(delivered).length
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered).length).toBe(count + 1)
      })

      it('a lead turn that runs out of room or hits a limit gets no continuation or retry', async () => {
        for (const ending of [
          failedDoneEvent('ru', 'max_turns', 'ran out'),
          {
            kind: 'error',
            fatal: true,
            code: 'rate_limit',
            message: '429',
            runId: 'ru',
            sessionId: null,
            ts: 1,
            seq: 1,
          } as RuntimeEvent,
        ]) {
          const { board, delivered, orchestrator, mainId, update } = await oneSubTaskIn()
          const count = delivered.length
          await orchestrator.onEvent(sk('leader'), ending, updateRun(update, 'u'))
          await vi.advanceTimersByTimeAsync(BRAKE_MAX_WAIT_MS)
          expect(board.statusOf(mainId)).toBe('in_progress')
          expect(await ledgerOf(board, mainId)).toEqual([])
          expect(delivered.slice(count).filter((d) => !d.task.startsWith('[Task Update]'))).toEqual(
            [],
          )
        }
      })

      it('an empty reply under a request still gets its one extra turn, then waits for a person', async () => {
        const { board, delivered, orchestrator } = makeHarness()
        await orchestrator.onEvent(
          sk('leader'),
          doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
          asked('d1'),
        )
        const childId = idsOf(board)[0]!
        const mainId = await parentOf(board, childId)
        await orchestrator.onEvent(sk('a2'), doneEvent('ra', ''))
        expect(board.statusOf(childId)).toBe('in_progress')
        await vi.advanceTimersByTimeAsync(1)
        expect(deliveredTo(delivered, 'a2').length).toBe(2)
        await orchestrator.onEvent(sk('a2'), doneEvent('rb', ''))
        expect(board.statusOf(childId)).toBe('blocked')
        await vi.advanceTimersByTimeAsync(1)
        expect(deliveredTo(delivered, 'a2').length).toBe(2)
        // The request waits with it, and none of this happened on the main task.
        expect(board.statusOf(mainId)).toBe('in_progress')
        expect((await board.mainTaskState(mainId))?.openSubtasks).toBe(1)
        expect(await ledgerOf(board, mainId)).toEqual([])
      })
    })

    it('holds a person’s words for the lead under a pause, and they go out on resume', async () => {
      let paused = true
      const outbox = new MemoryReportUps()
      const { board, delivered, orchestrator } = makeHarness({
        reportUps: outbox,
        runHeldBy: ({ taskId }) => (paused && taskId ? 'paused' : null),
      })
      await orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">a</delegate>'),
        asked('d1'),
      )
      const mainId = await parentOf(board, idsOf(board)[0]!)
      expect(await orchestrator.personCommentedOnMainTask(mainId, 'Add a logo')).toBe(true)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(delivered)).toEqual([])
      expect(outbox.pending().map((r) => r.item.summary)).toContain('Add a logo')
      paused = false
      await orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(lastUpdate(delivered).task).toContain('Add a logo')
    })
  })

  describe('createBoardOrchestrator: the failure breaker outlives its engine', () => {
    const failOnce = async (h: ReturnType<typeof makeHarness>, i: number): Promise<void> => {
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent(`r${i}`, '<delegate to="@Bug Boo">flaky</delegate>'),
      )
      await h.orchestrator.onEvent(sk('a2'), failedDoneEvent(`rc${i}`, 'error', 'boom'))
    }

    it('counts failures across a restart, and refuses on the next engine', async () => {
      const first = makeHarness()
      await failOnce(first, 0)
      await failOnce(first, 1)
      first.orchestrator.reset()
      const second = makeHarness({ board: first.board })
      await failOnce(second, 2)
      second.orchestrator.reset()
      const count = first.board.taskCount()

      const third = makeHarness({ board: first.board })
      await third.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r9', '<delegate to="@Bug Boo">flaky</delegate>'),
      )
      expect(first.board.taskCount()).toBe(count)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(third.delivered).some((r) => /failed .* times/i.test(r.task))).toBe(true)
    })

    it('tells the delegator once, across engines', async () => {
      const first = makeHarness()
      for (let i = 0; i < MAX_DELEGATION_FAILURES; i += 1) await failOnce(first, i)
      const handOff = doneEvent('r8', '<delegate to="@Bug Boo">flaky</delegate>')
      await first.orchestrator.onEvent(sk('leader'), handOff)
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(first.delivered).some((r) => /failed .* times/i.test(r.task))).toBe(true)
      first.orchestrator.reset()

      const next = makeHarness({ board: first.board })
      await next.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r9', '<delegate to="@Bug Boo">flaky</delegate>'),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(next.delivered)).toEqual([])
    })
  })
  // ─── A task's whole life: what one ending must not lose for the next ────────
  describe("createBoardOrchestrator: a task's whole life", () => {
    const handOff = doneEvent('r1', '<delegate to="@Bug Boo">fix the parser</delegate>')

    describe('a pause and the verdict', () => {
      const NOTE = 'Paused by a person. This run was stopped and starts again on resume.'

      it('a run a pause stopped keeps what its check found', async () => {
        const { board, orchestrator } = makeHarness()
        await orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        board.seedVerdict(id!)
        expect(await orchestrator.pauseRuns(() => true, NOTE)).toEqual([id])
        expect(board.statusOf(id!)).toBe('todo')
        expect(board.hasVerdict(id!)).toBe(true)
      })

      it('so does a fix round a pause catches before it starts', async () => {
        let paused = false
        const board = harness.makeBoard()
        openBoards.push(board)
        const h = makeHarness({
          board,
          runHeldBy: () => (paused ? NOTE : null),
          workCheck: {
            async begin() {},
            async prepare(taskId) {
              return async () => {
                await board.updateStatus(taskId, 'in_review')
                paused = true
                return { verdict: 'retry', fixNote: 'the parser still fails' }
              }
            },
          },
        })
        await h.orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        board.seedVerdict(id!)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'fixed'))
        await vi.advanceTimersByTimeAsync(0)
        expect(board.statusOf(id!)).toBe('todo')
        expect(board.hasVerdict(id!)).toBe(true)
      })
    })

    describe('a Stop', () => {
      it('holds a report-up that was only waiting for the sweep, so it starts nothing', async () => {
        const outbox = new MemoryReportUps()
        const left = outbox.record({ toAgentId: 'leader', by: 'Bug Boo', summary: 'an old result' })
        let gen = 0
        const { delivered, orchestrator } = makeHarness({ reportUps: outbox, stopGen: () => gen })
        gen = 1
        await orchestrator.markStopped()
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered)).toEqual([])
        expect(outbox.pending()).toEqual([])
        expect(outbox.held().map((r) => r.id)).toEqual([left])
      })

      it('holds it even when the write fails the first time', async () => {
        const outbox = new MemoryReportUps()
        const left = outbox.record({ toAgentId: 'leader', by: 'Bug Boo', summary: 'an old result' })
        let gen = 0
        const { delivered, orchestrator } = makeHarness({ reportUps: outbox, stopGen: () => gen })
        // It fails at the Stop and again at the first sweep, which still sends nothing.
        outbox.failHolds = 2
        gen = 1
        await orchestrator.markStopped()
        expect(outbox.pending().map((r) => r.id)).toEqual([left])
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered)).toEqual([])
        expect(outbox.pending().map((r) => r.id)).toEqual([left])
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered)).toEqual([])
        expect(outbox.held().map((r) => r.id)).toEqual([left])
      })

      it('ends what a round was told: the next try of a later run is not told it', async () => {
        let gen = 0
        const { board, delivered, orchestrator } = makeHarness({ stopGen: () => gen })
        await orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        // An empty reply: the agent is told so, in a round of its own.
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
        await vi.advanceTimersByTimeAsync(0)
        const toWorker = (): Delivered[] => delivered.filter((d) => d.agentId === 'a2')
        expect(toWorker().at(-1)!.task).toMatch(/^\[No reply\]/)

        gen = 1
        await orchestrator.markStopped()
        await orchestrator.onEvent(sk('a2'), failedDoneEvent('r3', 'aborted', ''))
        expect(await orchestrator.dispatchTask(id!)).toBe('started')
        expect(toWorker().at(-1)!.task).not.toMatch(/No reply/)

        await orchestrator.onEvent(
          sk('a2'),
          errorEvent('r4', '429 rate_limit_error: too many requests', true, 'rate_limit'),
        )
        await vi.advanceTimersByTimeAsync(BRAKE_MAX_WAIT_MS)
        expect(toWorker().length).toBeGreaterThan(3)
        expect(toWorker().at(-1)!.task).not.toMatch(/No reply/)
      })
    })

    describe('the reply and its check', () => {
      const answering = (
        board: CascadeBoard,
        answer: () => Promise<WorkCheckResult>,
      ): WorkCheck => ({
        async begin() {},
        async prepare(taskId) {
          return async () => {
            await board.updateStatus(taskId, 'in_review')
            return answer()
          }
        },
      })
      const repliesOn = (board: CascadeBoard, id: string, reply: string): number =>
        board.comments.filter((c) => c.taskId === id && c.body === reply).length

      it('is on the card as soon as the check starts, and a restart keeps it', async () => {
        const board = harness.makeBoard()
        openBoards.push(board)
        const first = makeHarness({
          board,
          workCheck: answering(board, () => new Promise<WorkCheckResult>(() => undefined)),
        })
        await first.orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        await first.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'I changed parser.ts'))
        await vi.advanceTimersByTimeAsync(0)
        expect(board.statusOf(id!)).toBe('in_review')
        expect(repliesOn(board, id!, 'I changed parser.ts')).toBe(1)

        // The server dies mid-check, and the next engine finds the task.
        vi.clearAllTimers()
        const next = makeHarness({
          board,
          workCheck: { begin: async () => undefined, prepare: async () => null },
        })
        await next.orchestrator.resume()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(board.statusOf(id!)).toBe('blocked')
        const [update] = reflections(next.delivered)
        expect(update!.task).toMatch(/restarted/i)
        expect(update!.task).toContain('I changed parser.ts')
      })

      it('is not posted again when the check passes', async () => {
        const board = harness.makeBoard()
        openBoards.push(board)
        const { orchestrator } = makeHarness({
          board,
          workCheck: answering(board, async () => ({ verdict: 'pass' })),
        })
        await orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'I changed parser.ts'))
        await vi.advanceTimersByTimeAsync(0)
        expect(board.statusOf(id!)).toBe('done')
        expect(repliesOn(board, id!, 'I changed parser.ts')).toBe(1)
      })

      it('each round says its own, once', async () => {
        const board = harness.makeBoard()
        openBoards.push(board)
        const answers: WorkCheckResult[] = [
          { verdict: 'retry', fixNote: 'it still fails' },
          { verdict: 'pass' },
        ]
        const { orchestrator } = makeHarness({
          board,
          workCheck: answering(board, async () => answers.shift()!),
        })
        await orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'first try'))
        await vi.advanceTimersByTimeAsync(0)
        await orchestrator.onEvent(sk('a2'), doneEvent('r3', 'second try'))
        await vi.advanceTimersByTimeAsync(0)
        expect(board.statusOf(id!)).toBe('done')
        expect(repliesOn(board, id!, 'first try')).toBe(1)
        expect(repliesOn(board, id!, 'second try')).toBe(1)
      })

      it('a write that fails at the start of the check is left to what follows it', async () => {
        const board = harness.makeBoard()
        openBoards.push(board)
        const { orchestrator } = makeHarness({
          board,
          workCheck: answering(board, async () => {
            board.failComments(false)
            return { verdict: 'pass' }
          }),
        })
        await orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        board.failComments(true)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'I changed parser.ts'))
        await vi.advanceTimersByTimeAsync(0)
        expect(board.statusOf(id!)).toBe('done')
        expect(repliesOn(board, id!, 'I changed parser.ts')).toBe(1)
      })

      it('stays on the card once when a Stop ends the wait for its check', async () => {
        const board = harness.makeBoard()
        openBoards.push(board)
        let gen = 0
        const { orchestrator } = makeHarness({
          board,
          stopGen: () => gen,
          workCheck: {
            async begin() {},
            async prepare() {
              return Object.assign(async (): Promise<WorkCheckResult> => ({ verdict: 'pass' }), {
                hold: async (signal: AbortSignal) =>
                  new Promise<() => void>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('ended')))
                  }),
              })
            },
          },
        })
        await orchestrator.onEvent(sk('leader'), handOff)
        const [id] = idsOf(board)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'I changed parser.ts'))
        await vi.advanceTimersByTimeAsync(0)
        gen = 1
        await orchestrator.markStopped()
        await vi.advanceTimersByTimeAsync(0)
        expect(board.statusOf(id!)).toBe('todo')
        expect(repliesOn(board, id!, 'I changed parser.ts')).toBe(1)
      })
    })

    describe('a budget whose room runs already going set aside', () => {
      const held = (): Error =>
        new DeliveryRefusedError('Runs already going set aside the room.', {
          budget: true,
          budgetReason: 'held',
        })

      it('holds a task update back, uncounted, until there is room', async () => {
        const outbox = new MemoryReportUps()
        let room = false
        const { delivered, narrations, orchestrator } = makeHarness({
          reportUps: outbox,
          deliverThrows: (agentId) => (agentId === 'leader' && !room ? held() : null),
        })
        await orchestrator.onEvent(sk('leader'), handOff)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'a result'))
        for (let i = 0; i < 8; i++) {
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
          await orchestrator.sweepStaleSessions()
        }
        const [row] = outbox.pending()
        expect(row).toBeDefined()
        expect(row!.replays).toBe(0)
        expect(outbox.settledHow(row!.id)).toBeNull()
        expect(narrations.filter((n) => /could not be delivered/.test(n.text))).toEqual([])
        expect(reflections(delivered)).toEqual([])

        room = true
        await orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(delivered)).toHaveLength(1)
        expect(reflections(delivered)[0]!.task).toContain('a result')
      })

      it('counts no try for one it refused while it waited for its turn', async () => {
        const outbox = new MemoryReportUps()
        const { delivered, orchestrator } = makeHarness({ reportUps: outbox })
        await orchestrator.onEvent(sk('leader'), handOff)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'a result'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const [update] = reflections(delivered)
        const ids = update!.origin.kind === 'system' ? update!.origin.reportUpIds! : []
        expect(ids).toHaveLength(1)
        for (let i = 0; i < 6; i++) {
          orchestrator.onRunNotStarted({
            reportForTaskId: null,
            stopGen: 0,
            reportUpIds: ids,
            budgetHeld: true,
          })
          await orchestrator.sweepStaleSessions()
          await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        }
        expect(outbox.settledHow(ids[0]!)).toBeNull()
      })

      it('a cap a person must raise still ends in telling them', async () => {
        const outbox = new MemoryReportUps()
        const { narrations, orchestrator } = makeHarness({
          reportUps: outbox,
          deliverThrows: (agentId) =>
            agentId === 'leader'
              ? new DeliveryRefusedError('The cap is reached.', { budget: true })
              : null,
        })
        await orchestrator.onEvent(sk('leader'), handOff)
        await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'a result'))
        for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(narrations.filter((n) => /could not be delivered/.test(n.text))).toHaveLength(1)
      })
    })

    it('failing a task aborts that task’s run, and names it', async () => {
      const { board, abortedTasks, orchestrator } = makeHarness()
      await orchestrator.onEvent(sk('leader'), handOff)
      const [id] = idsOf(board)
      await orchestrator.onEvent(sk('a2'), errorEvent('r2', 'it broke', true))
      expect(abortedTasks).toEqual([id])
    })

    it('a hand-off a closed request refused is said in the chat, and to its sender', async () => {
      const { board, delivered, narrations, orchestrator } = makeHarness({
        reportUps: new MemoryReportUps(),
      })
      await orchestrator.onEvent(sk('leader'), handOff, {
        reportForTaskId: null,
        stopGen: 0,
        deliveryId: 'd1',
        request: { words: 'Fix the parser', requestedBy: { id: 'p1', name: 'Pat', role: null } },
      })
      const mainId = (await board.getTask(idsOf(board)[0]!))!.task.parentTaskId as string
      await orchestrator.onEvent(sk('a2'), doneEvent('r2', 'done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const update = reflections(delivered).at(-1)!
      const before = reflections(delivered).length
      expect(await board.closeMainTask(mainId, 'cancelled')).toBe(true)

      await orchestrator.onEvent(
        sk('leader'),
        toolCallEvent('r3', 'delegate', { assignee: 'Design Boo', task: 'and one more thing' }),
        {
          reportForTaskId: null,
          stopGen: 0,
          deliveryId: 'u',
          ...(update.origin.kind === 'system' && update.origin.mainTaskId
            ? { mainTaskId: update.origin.mainTaskId }
            : {}),
        },
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(narrations.some((n) => /This request has closed/.test(n.text))).toBe(true)
      // It starts no run: the note waits in the mailbox for the sender's next turn.
      expect(reflections(delivered)).toHaveLength(before)
    })
  })

  describe('createBoardOrchestrator: a job starts only so many runs by itself', () => {
    const stampFor = (d: Delivered): RunStamp => ({
      reportForTaskId: null,
      stopGen: 0,
      ...(d.reportUpIds?.length ? { reportUpIds: d.reportUpIds } : {}),
    })

    it('counts the runs it starts, across the whole job', async () => {
      const h = makeHarness()
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      expect(h.board.jobRunsOf(top)).toBe(1)
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'more. <delegate to="@Design Boo">sub</delegate>'),
      )
      // The sub-task's run counts toward the job at the top of the tree.
      const sub = h.board.created.find((t) => t.title === 'sub')!.id
      expect(h.board.jobRunsOf(sub)).toBe(2)
      expect(h.board.jobRunsOf(top)).toBe(2)
    })

    it('a hand-off at the limit waits in To do, starts nothing, and its parent waits on it', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      h.board.seedJobRuns(top, 7)
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'more. <delegate to="@Design Boo">sub</delegate>'),
      )
      const sub = h.board.created.find((t) => t.title === 'sub')!.id
      expect(h.board.statusOf(sub)).toBe('todo')
      expect(h.delivered.filter((d) => d.agentId === 'a3')).toEqual([])
      expect(h.board.jobRunsOf(sub)).toBe(7)
      expect(h.board.statusOf(top)).toBe('blocked')

      // Pumps change nothing however often they run.
      await h.orchestrator.sweepStaleSessions()
      await h.orchestrator.sweepStaleSessions()
      expect(h.delivered.filter((d) => d.agentId === 'a3')).toEqual([])
      expect(h.board.jobRunsOf(sub)).toBe(7)

      // A person says to carry on, and the waiting work starts.
      h.board.carryOnJobRuns(top)
      await h.orchestrator.resume()
      expect(h.delivered.filter((d) => d.agentId === 'a3')).toHaveLength(1)
      expect(h.board.statusOf(sub)).toBe('in_progress')
      expect(h.board.jobRunsOf(sub)).toBe(8)
    })

    it('a chain of follow-ups stops at the limit, then goes on when a person says so', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r2', 'part one. <delegate to="@Design Boo">sub</delegate>'),
      )
      const before = h.delivered.filter((d) => d.agentId === 'a2').length
      const count = h.board.jobRunsOf(top)
      h.board.seedJobRuns(top, count)

      // The sub-task ends. The parent would follow up on it, and has no room to.
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await h.orchestrator.resume()
      expect(h.board.statusOf(top)).toBe('todo')
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(before)
      expect(h.board.jobRunsOf(top)).toBe(count)

      h.board.carryOnJobRuns(top)
      await h.orchestrator.resume()
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(before + 1)
      expect(h.board.statusOf(top)).toBe('in_progress')
    })

    it('a person’s dispatch goes at the limit, and spends nothing', async () => {
      const h = makeHarness()
      const task = await h.board.createTask({
        teamId: 't1',
        title: 'theirs',
        sourceDelegationId: 'human:1:agent:a2:origin:human',
      })
      h.board.seedJobRuns(task!.id, 5)
      expect(await h.orchestrator.dispatchTask(task!.id)).toBe('started')
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
      expect(h.board.jobRunsOf(task!.id)).toBe(5)
    })

    it('an empty reply’s second turn waits at the limit', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      const before = h.delivered.filter((d) => d.agentId === 'a2').length
      h.board.seedJobRuns(top, h.board.jobRunsOf(top))
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', ''))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(before)
      expect(h.board.statusOf(top)).toBe('todo')
      expect(h.board.comments.some((c) => /as many runs by itself/.test(c.body))).toBe(true)
    })

    it('a fix round waits at the limit, and the check it failed stays on the task', async () => {
      const workCheck: WorkCheck = {
        async begin() {},
        async prepare() {
          return async () => ({ verdict: 'retry', fixNote: 'the tests fail' })
        },
      }
      const h = makeHarness({ reportUps: new MemoryReportUps(), workCheck })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      const before = h.delivered.filter((d) => d.agentId === 'a2').length
      h.board.seedJobRuns(top, h.board.jobRunsOf(top))
      h.board.seedFailedCheck(top)
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'done, I think'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(before)
      expect(h.board.statusOf(top)).toBe('todo')
      expect(h.board.comments.some((c) => /as many runs by itself/.test(c.body))).toBe(true)
      expect(h.board.hasFailedCheck(top)).toBe(true)

      // A person says to carry on, and the round it was to have goes.
      h.board.carryOnJobRuns(top)
      await h.orchestrator.resume()
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(before + 1)
    })

    it('an update turn waits at the limit, uncounted, and goes when a person says so', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      const count = h.board.jobRunsOf(top)
      h.board.seedJobRuns(top, count)
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'all done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
      expect(outbox.pending().map((r) => r.item.taskId)).toEqual([top])
      expect(outbox.pending()[0]!.replays).toBe(0)
      // A sweep finds it pending and leaves it, whatever else it does.
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
      expect(h.board.jobRunsOf(top)).toBe(count)

      h.board.carryOnJobRuns(top)
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toHaveLength(1)
      expect(h.board.jobRunsOf(top)).toBe(count + 1)
    })

    it('a budget refusing an update turn counts nothing, however often it tries', async () => {
      let room = false
      const h = makeHarness({
        reportUps: new MemoryReportUps(),
        deliverThrows: (agentId) =>
          agentId === 'leader' && !room
            ? new DeliveryRefusedError('Runs already going set aside the room.', {
                budget: true,
                budgetReason: 'held',
              })
            : null,
      })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'all done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const count = h.board.jobRunsOf(top)
      for (let i = 0; i < 5; i += 1) {
        await h.orchestrator.sweepStaleSessions()
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      }
      expect(reflections(h.delivered)).toEqual([])
      expect(h.board.jobRunsOf(top)).toBe(count)

      room = true
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toHaveLength(1)
      expect(h.board.jobRunsOf(top)).toBe(count + 1)
    })

    it('an update reading two jobs counts toward both, once it has started', async () => {
      const h = makeHarness()
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          'go. <delegate to="@Bug Boo">a</delegate> <delegate to="@Design Boo">b</delegate>',
        ),
      )
      const [a, b] = idsOf(h.board)
      const before = [h.board.jobRunsOf(a!), h.board.jobRunsOf(b!)]
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'a is done'))
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'b is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toHaveLength(1)
      expect(h.board.jobRunsOf(a!)).toBe(before[0]! + 1)
      expect(h.board.jobRunsOf(b!)).toBe(before[1]! + 1)
    })

    it('a note that only names a task is held at the limit, so it waits on no card', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      h.orchestrator.detachTask(top)
      await h.board.updateStatus(top, 'done')
      h.board.seedJobRuns(top, h.board.jobRunsOf(top))
      outbox.record({
        toAgentId: 'a2',
        by: 'Design Boo',
        title: 'more',
        summary: 'Not handed off.',
        outcome: 'not_started',
        forTaskId: top,
      })
      await h.orchestrator.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
      expect(outbox.pending()).toEqual([])
      expect(outbox.held().map((r) => r.item.forTaskId)).toEqual([top])
    })

    it('and one the limit reached while it waited to go out', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      h.orchestrator.detachTask(top)
      await h.board.updateStatus(top, 'done')
      outbox.record({
        toAgentId: 'a2',
        by: 'Design Boo',
        title: 'more',
        summary: 'Not handed off.',
        outcome: 'not_started',
        forTaskId: top,
      })
      await h.orchestrator.sweepStaleSessions()
      h.board.seedJobRuns(top, h.board.jobRunsOf(top))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
      expect(outbox.pending()).toEqual([])
      expect(outbox.held().map((r) => r.item.forTaskId)).toEqual([top])
    })

    it('a person’s ask left for a busy agent goes when the agent frees up', async () => {
      const occupied = new Set<string>()
      const h = makeHarness({ occupiedSessions: occupied })
      const task = await h.board.createTask({
        teamId: 't1',
        title: 'theirs',
        sourceDelegationId: 'run-1:deleg:agent:a2:reflectTo:leader',
      })
      h.board.seedJobRuns(task!.id, 5)
      occupied.add(sk('a2'))
      expect(await h.orchestrator.dispatchTask(task!.id)).toBe('queued')
      occupied.delete(sk('a2'))
      await h.orchestrator.resume()
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
      expect(h.board.jobRunsOf(task!.id)).toBe(5)
    })

    it('that ask does not outlast a run on another path', async () => {
      const occupied = new Set<string>()
      const h = makeHarness({ occupiedSessions: occupied })
      const task = await h.board.createTask({
        teamId: 't1',
        title: 'theirs',
        sourceDelegationId: 'run-1:deleg:agent:a2:reflectTo:leader',
      })
      occupied.add(sk('a2'))
      expect(await h.orchestrator.dispatchTask(task!.id)).toBe('queued')
      // It ran some other way, came back to To do, and the job has reached its limit since.
      const exec = await h.board.createExecution(task!.id, 'openclaw')
      await h.board.completeExecution(exec!.id, { status: 'succeeded' })
      h.board.seedJobRuns(task!.id, 5)
      occupied.delete(sk('a2'))
      await h.orchestrator.resume()
      await h.orchestrator.sweepStaleSessions()
      expect(h.delivered.filter((d) => d.agentId === 'a2')).toEqual([])
      expect(h.board.jobRunsOf(task!.id)).toBe(5)
      expect(h.board.statusOf(task!.id)).toBe('todo')
    })

    it('an automatic start counts, reads as no person’s, and the limit refuses it', async () => {
      const h = makeHarness()
      const task = await h.board.createTask({
        teamId: 't1',
        title: 'by itself',
        sourceDelegationId: 'run-1:deleg:agent:a2:reflectTo:leader',
      })
      const stale = await h.board.createExecution(task!.id, 'openclaw')
      await h.board.completeExecution(stale!.id, { status: 'failed', error: 'over the cap' })
      expect(await h.orchestrator.dispatchTask(task!.id, { automatic: true })).toBe('started')
      expect(h.board.jobRunsOf(task!.id)).toBe(1)

      const next = await h.board.createTask({
        teamId: 't1',
        title: 'at the limit',
        sourceDelegationId: 'run-2:deleg:agent:a3:reflectTo:leader',
      })
      h.board.seedJobRuns(next!.id, 5)
      expect(await h.orchestrator.dispatchTask(next!.id, { automatic: true })).toBe('not_ready')
      expect(h.delivered.filter((d) => d.agentId === 'a3')).toEqual([])
      expect(h.board.jobRunsOf(next!.id)).toBe(5)
    })

    describe('Stop on the card', () => {
      const NOTE = 'A person stopped this job.'
      const twoJobs = async (reportUps?: MemoryReportUps) => {
        const h = makeHarness(reportUps ? { reportUps } : {})
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent(
            'r1',
            'go. <delegate to="@Bug Boo">a</delegate> <delegate to="@Design Boo">b</delegate>',
          ),
        )
        const [a, b] = idsOf(h.board)
        return { h, a: a!, b: b! }
      }

      it('ends that job’s runs, and the other job goes on', async () => {
        const { h, a, b } = await twoJobs()
        expect(await h.orchestrator.stopJobRuns(new Set([a]), NOTE)).toEqual([a])
        expect(h.abortedTasks).toEqual([a])
        expect(h.board.statusOf(a)).toBe('todo')
        expect(h.board.statusOf(b)).toBe('in_progress')
        const last = (await ledgerOf(h.board, a)).at(-1)!
        expect(last.status).toBe('cancelled')
        expect(last.errorClass ?? null).toBeNull()
        expect(h.board.comments.some((c) => c.taskId === a && c.body === NOTE)).toBe(true)

        // It reads as a person's Stop, so no pump starts it.
        const before = h.delivered.filter((d) => d.agentId === 'a2').length
        await h.orchestrator.resume()
        await h.orchestrator.sweepStaleSessions()
        expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(before)

        // The other job is untouched, and reports as it would have.
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'b is done'))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        expect(reflections(h.delivered)).toHaveLength(1)
        expect(reflections(h.delivered)[0]!.task).toContain('b is done')
      })

      it('holds what it had on its way about that job, and sends the other’s', async () => {
        const outbox = new MemoryReportUps()
        const { h, a, b } = await twoJobs(outbox)
        await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'a is done'))
        await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'b is done'))
        expect(await h.orchestrator.stopJobRuns(new Set([a]), NOTE)).toEqual([])
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const sent = reflections(h.delivered)
        expect(sent).toHaveLength(1)
        expect(sent[0]!.task).toContain('b is done')
        expect(sent[0]!.task).not.toContain('a is done')
        expect(outbox.held().map((r) => r.item.taskId)).toEqual([a])
        expect(outbox.pending().map((r) => r.item.taskId)).toEqual([b])
      })

      it('a plan stops at its running step, and the steps behind it stay put', async () => {
        const h = makeHarness()
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent(
            'r1',
            '<plan><step to="@Bug Boo">first</step><step to="@Design Boo">second</step></plan>',
          ),
        )
        const [first, second] = idsOf(h.board)
        expect(h.board.statusOf(first!)).toBe('in_progress')
        expect(await h.orchestrator.stopJobRuns(new Set([first!, second!]), NOTE)).toEqual([first])
        expect(h.board.statusOf(first!)).toBe('todo')
        expect(h.board.statusOf(second!)).toBe('todo')
        await h.orchestrator.resume()
        await h.orchestrator.sweepStaleSessions()
        expect(h.delivered.filter((d) => d.agentId === 'a2')).toHaveLength(1)
        expect(h.delivered.filter((d) => d.agentId === 'a3')).toEqual([])
        // A person's Retry of the first carries it on, at the limit and all.
        h.board.seedJobRuns(first!, 5)
        h.board.seedJobStopped(first!)
        expect(await h.orchestrator.dispatchTask(first!)).toBe('started')
        expect(h.board.jobIsStopped(first!)).toBe(false)
        expect(h.board.jobRunsOf(first!)).toBe(5)
      })

      it('takes back a person’s earlier ask on that job', async () => {
        const occupied = new Set<string>()
        const h = makeHarness({ occupiedSessions: occupied })
        const task = await h.board.createTask({
          teamId: 't1',
          title: 'theirs',
          sourceDelegationId: 'run-1:deleg:agent:a2:reflectTo:leader',
        })
        h.board.seedJobRuns(task!.id, 5)
        occupied.add(sk('a2'))
        expect(await h.orchestrator.dispatchTask(task!.id)).toBe('queued')
        await h.orchestrator.stopJobRuns(new Set([task!.id]), NOTE)
        occupied.delete(sk('a2'))
        await h.orchestrator.resume()
        expect(h.delivered.filter((d) => d.agentId === 'a2')).toEqual([])
      })
    })

    it('a turn reading a result with no request nests what it hands out under that job', async () => {
      const h = makeHarness()
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'all done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const update = reflections(h.delivered)[0]!
      expect(update.origin).toMatchObject({ kind: 'system', jobTaskId: top })
      // Its reply hands out the next piece: it is not a new job with a new count.
      const count = h.board.jobRunsOf(top)
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r3', 'next. <delegate to="@Design Boo">next piece</delegate>'),
        { ...stampFor(update), jobTaskId: top },
      )
      const next = h.board.created.find((t) => t.title === 'next piece')!
      expect(next.parentTaskId).toBe(top)
      expect(h.board.jobRunsOf(next.id)).toBe(count + 1)
    })

    it('so an endless chain of update turns stops at the limit', async () => {
      const h = makeHarness()
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r0', '<delegate to="@Bug Boo">piece 0</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      // Each piece is two runs: its own, and the update turn that reads it.
      const limit = 7
      h.board.seedJobRuns(top, 1, limit)
      let pieces = 1
      for (let i = 1; i < 20; i += 1) {
        await h.orchestrator.onEvent(sk('a2'), doneEvent(`w${i}`, `piece ${i - 1} done`))
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        const update = reflections(h.delivered).find((d) => d.task.includes(`piece ${i - 1} done`))
        if (!update) break
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent(`l${i}`, `next. <delegate to="@Bug Boo">piece ${i}</delegate>`),
          { ...stampFor(update), jobTaskId: top },
        )
        pieces += 1
      }
      expect(h.board.jobRunsOf(top)).toBe(limit)
      expect(pieces).toBeLessThan(6)
    })

    it('updates for a busy session wait, and go as one when its turn ends', async () => {
      const occupied = new Set<string>()
      const h = makeHarness({ occupiedSessions: occupied })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent(
          'r1',
          'go. <delegate to="@Bug Boo">a</delegate> <delegate to="@Design Boo">b</delegate>',
        ),
      )
      occupied.add(sk('leader'))
      await h.orchestrator.onEvent(sk('a2'), doneEvent('r2', 'a is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(reflections(h.delivered)).toEqual([])
      // Something else comes in while the turn goes on.
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'b is done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
      expect(reflections(h.delivered)).toEqual([])

      occupied.delete(sk('leader'))
      await h.orchestrator.onEvent(sk('leader'), doneEvent('rP', 'answered the person'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      const sent = reflections(h.delivered)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.task).toContain('a is done')
      expect(sent[0]!.task).toContain('b is done')
    })

    it('a note with no task stops waking its agent after a few', async () => {
      // Nothing can take these, so each hand-off comes back as a note with no task.
      const h = makeHarness({ sessionKeyForAgent: (id) => (id === 'a2' ? null : sk(id)) })
      for (let i = 0; i < MAX_REFUSAL_TURNS + 3; i += 1) {
        await h.orchestrator.onEvent(
          sk('leader'),
          doneEvent(`r${i}`, `<delegate to="@Bug Boo">flaky ${i}</delegate>`),
        )
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      }
      expect(reflections(h.delivered)).toHaveLength(MAX_REFUSAL_TURNS)
      expect(h.narrations.some((x) => /not being told again/.test(x.text))).toBe(true)
    })

    it('one follow-up takes every result, however long, and is not asked for again', async () => {
      const outbox = new MemoryReportUps()
      const h = makeHarness({ reportUps: outbox })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      const top = idsOf(h.board)[0]!
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent(
          'r2',
          'split. <delegate to="@Design Boo">a</delegate> <delegate to="@Test Boo">b</delegate>',
        ),
      )
      const long = (c: string): string => c.repeat(HELD_REPORT_UPS_BUDGET_CHARS)
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', long('A')))
      await h.orchestrator.onEvent(sk('a4'), doneEvent('r4', long('B')))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await h.orchestrator.resume()

      const followUps = h.delivered.filter((d) => d.agentId === 'a2' && d.context)
      expect(followUps).toHaveLength(1)
      const context = followUps[0]!.context!
      expect(context).toContain('AAA')
      expect(context).toContain('BBB')
      expect(context).toContain('get_task')
      expect(followUps[0]!.reportUpIds).toHaveLength(2)
      expect(context.length).toBeLessThan(HELD_REPORT_UPS_BUDGET_CHARS + 2_000)
      expect(h.board.statusOf(top)).toBe('in_progress')

      // It ends, and nothing it already covered parks the task again.
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent('r5', 'both in, and here is what they add up to'),
        stampFor(followUps[0]!),
      )
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      expect(h.board.statusOf(top)).toBe('done')
      expect(outbox.unsettledFor('a2')).toEqual([])
    })

    it('a follow-up is shown what it reported before, since its reply replaces it', async () => {
      const h = makeHarness({ reportUps: new MemoryReportUps() })
      await h.orchestrator.onEvent(
        sk('leader'),
        doneEvent('r1', '<delegate to="@Bug Boo">top</delegate>'),
      )
      await h.orchestrator.onEvent(
        sk('a2'),
        doneEvent(
          'r2',
          'The first half is the part that matters. <delegate to="@Design Boo">sub</delegate>',
        ),
      )
      await h.orchestrator.onEvent(sk('a3'), doneEvent('r3', 'sub done'))
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      await h.orchestrator.resume()
      const followUp = h.delivered.filter((d) => d.agentId === 'a2').at(-1)!
      expect(followUp.task).toContain('The first half is the part that matters')
    })
  })
}
