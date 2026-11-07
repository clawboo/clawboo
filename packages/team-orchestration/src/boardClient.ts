// The durable-board surface the orchestration engine depends on, as an interface
// so each host injects its own implementation: the browser binds a `fetch`-based
// REST client (apps/web/src/lib/boardClient.ts), the server binds a direct-DB
// client over @clawboo/db (apps/web/server/lib/teamChat/serverBoardClient.ts),
// and the test suite injects a fake. Every method is defensive (network/parse/DB
// failures resolve to a null/false result, never throw) and 409-aware: a claim
// conflict means "someone else won" and MUST NOT be retried.

// The 7 canonical task statuses, from the pure zero-dep rulebook both hosts share.
// @clawboo/board-core carries no server/db graph, so this host-agnostic interface
// package stays browser-safe while using the SAME union @clawboo/db enforces — a
// host binding over the direct-DB client type-checks by identity, not by luck.
import type {
  HandOffLink,
  ResultClaim,
  SubtaskView,
  LocalPersonRef,
  TaskStatus,
  TaskWakeReason,
  WaitingOn,
} from '@clawboo/board-core'

export type { HandOffLink, TaskStatus, WaitingOn }

export interface CreateTaskInput {
  title: string
  description?: string
  /** Initial status; the server defaults to 'todo' when omitted. */
  status?: TaskStatus
  teamId?: string
  assigneeRuntime?: string
  parentTaskId?: string
  sourceDelegationId?: string
  /** The one-to-one chat it was handed off from: its card shows there, and its
   *  result goes back there. */
  chatSessionKey?: string
  /** The person who asked for it. */
  requestedBy?: LocalPersonRef
}

export interface BoardTask {
  id: string
  status: string
  /** The readable id, like `CLB-12`; null for a task with no team. */
  identifier?: string | null
  title?: string
  description?: string | null
  teamId?: string | null
  assigneeAgentId?: string | null
  parentTaskId?: string | null
  createdAt?: number
  updatedAt?: number
  /** 1: a person's main task, which holds their request and never runs by itself. */
  isMainTask?: number | boolean
  [k: string]: unknown
}

/** `job_limit`: the job has started all the runs it may by itself. The task stays in To
 *  do, and a person says to carry on. */
export type ClaimReason = 'conflict' | 'not_found' | 'error' | 'paused' | 'job_limit'
export interface ClaimResult {
  ok: boolean
  reason?: ClaimReason
  task?: BoardTask
  /** The run the claim opened, when it was asked to open one and this board does
   *  that in the claim's own write. Absent: the caller opens the run itself. */
  execution?: ExecutionRef
  /** The saved wakes the run took, written with the claim. */
  wakes?: ClaimedWake[]
}

/** The run a claim opens, in the same write as the claim. */
export interface ClaimRun {
  executorType: string
  /** Why it runs. A saved wake it takes names the reason instead. */
  runReason?: string | null
  /** False: a person asked for this run, so it neither spends from its job's count nor
   *  waits at the limit. Left out, its reason decides. */
  automatic?: boolean
}

/** A saved wake a run took when it claimed its task. */
export interface ClaimedWake {
  id: string
  reason: TaskWakeReason
  commentIds: string[]
}

export interface TaskDetail {
  task: BoardTask
  comments: unknown[]
  /** `isMainTask`: a person's main task, which is not a level for the depth caps.
   *  `agentId`: who was given that task, when the host knows. */
  ancestors: { id: string; isMainTask?: boolean; agentId?: string | null }[]
}

export interface ExecutionRef {
  id: string
}

/** One ledger row of a task's run history — the durable input to the ready-pump's
 *  fire policy (a `cancelled` last run = user Stop = never auto-refire) and to
 *  resume()'s ownership check (`isEngineRun` tells the engine whether a running
 *  exec is its OWN fire — watchdog-attachable — or an executor-runner run whose
 *  events it will never see and must not falsely time out). */
export interface ExecutionSummary {
  id: string
  status: string
  executorType?: string
  /** The row's engine marker. A host that gives neither this nor `executorType` has
   *  only the engine's own runs to report. */
  engineRun?: number | boolean | null
  /** The class a failed run was filed under (the runtime error taxonomy). */
  errorClass?: string | null
  /** When it ended, and whether it made visible progress: the no-progress brake
   *  reads both (see `brakeUntil`). */
  completedAt?: number | null
  madeProgress?: boolean | number | null
  /** What it failed with, and whether its process died with the last server: how
   *  the fire policy tells a crash from an error (see `runKindOf`). */
  error?: string | null
  recoveryTombstone?: number | null
  /** Why it started (`TaskRunReason`), and when it opened. */
  runReason?: string | null
  createdAt?: number | null
}

export interface CompleteExecutionOutcome {
  /** `budget_*`: a budget cap stopped it. `cancelled` is a person's word. */
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'budget_paused' | 'budget_held'
  summary?: string
  error?: string
  /** The class the run's failure was filed under (`classifyError`). */
  errorClass?: string
  /** A person ended this run: their Stop, or moving its card. What it carried is held
   *  for the next run. Other `cancelled` closes give it back to the pump. */
  byPerson?: boolean
  costUsd?: number
}

/** The board surface the orchestrator needs. An interface so tests inject a fake. */
export interface BoardClient {
  createTask(input: CreateTaskInput): Promise<BoardTask | null>
  claim(
    taskId: string,
    assigneeAgentId: string,
    assigneeRuntime?: string,
    run?: ClaimRun,
  ): Promise<ClaimResult>
  /** `waitingOn` says what a task moved to Blocked or In review now waits for. A
   *  host that cannot store it (the browser's REST client) leaves it out. */
  updateStatus(
    taskId: string,
    status: string,
    opts?: {
      waitingOn?: WaitingOn
      /** A move to To do keeps the stored verdict: the same work is coming back. */
      keepVerdict?: boolean
    },
  ): Promise<boolean>
  /** Say what a task waits for without moving it (a check whose move to Blocked
   *  keeps failing). Best-effort; a host may not have it. */
  setWaitingOn?(taskId: string, waitingOn: WaitingOn | null): Promise<void>
  /** True once the comment is written. False when the write failed: never throws. */
  addComment(
    taskId: string,
    body: string,
    authorType?: 'agent' | 'user' | 'system',
    authorAgentId?: string,
  ): Promise<boolean>
  getTask(taskId: string): Promise<TaskDetail | null>
  createExecution(
    taskId: string,
    executorType: string,
    /** `countJobRun`: this run is one its job counts, in the write that opens it. */
    opts?: { runReason?: string; countJobRun?: boolean },
  ): Promise<ExecutionRef | null>
  completeExecution(execId: string, outcome: CompleteExecutionOutcome): Promise<void>
  /** Link a dependency: `taskId` waits on `dependsOnTaskId` (plans / blockedBy). */
  linkDep(taskId: string, dependsOnTaskId: string): Promise<boolean>
  /** Team tasks that are `todo` with all dependencies satisfied (fire-ready). */
  getReadyTasks(teamId: string): Promise<BoardTask[]>
  /**
   * A task's execution ledger, oldest first. `null` means the ledger could not be
   * READ, which is not the same as "this task has never run" and must never be
   * collapsed into `[]`: an empty ledger is the strongest evidence a task is
   * fireable, so a transient read failure would turn a user-Stopped delegation
   * into an auto-fired one and quietly invert the durable-Stop guarantee.
   * Callers treat `null` as "unknown, do nothing this pass".
   */
  listExecutions(taskId: string): Promise<ExecutionSummary[] | null>
  /** All non-dropped tasks for a team (the projection load). */
  listTasks(teamId: string): Promise<BoardTask[]>
  /** The tasks waiting directly on this one. Optional: a host without it leaves the
   *  ready-pump's own policy as the only guard after a Stop. */
  directDependents?(taskId: string): Promise<string[]>
  /**
   * Cancel the still-pending downstream chain of a FAILED task (its dependents
   * can never become ready). Returns the cancelled tasks so the orchestrator can
   * tell the leader the plan chain stalled.
   */
  cancelDependents(taskId: string): Promise<Array<{ id: string; title?: string }>>
}

/** A hand-off the engine wants on the board. */
export interface HandOffInput extends CreateTaskInput {
  /**
   * What makes a replay of this hand-off return the same task: who sent it from
   * which turn, and the words. Left out when the event has no turn, since nothing
   * then says it is the same hand-off.
   */
  handOffKey?: { scope: readonly string[]; text: string }
  /**
   * The turn it comes from. The same-title check skips this turn's own tasks: a turn
   * asking two teammates the same thing, or a plan repeating a step (test, fix, test),
   * means each one. A later turn saying the same words is a retry.
   */
  turnId?: string
  /** File it under the main task of this person's message, making that task if this
   *  is its first hand-off. A repeat of open work makes neither. */
  mainTask?: MainTaskInput
}

/** A person's request as a main task (see `HandOffInput.mainTask`). */
export interface MainTaskInput {
  title: string
  /** Their whole words. */
  description: string
  /** The agent looking after it: who its reports go to. */
  leadAgentId: string
  requestedBy?: { id: string; name: string | null; role: string | null } | null
  /** One per message, so every hand-off of its turn finds the same main task. */
  key: string
  /** The one-to-one chat the message came from: what reports on the request goes there. */
  chatSessionKey?: string
}

/** Where a person's request stands, read from the board. */
export interface MainTaskState {
  id: string
  title: string
  identifier: string | null
  status: string
  leadAgentId: string | null
  /** Not Done or Cancelled, and not removed. */
  open: boolean
  /** Everything filed under it, at any depth. */
  subtaskIds: string[]
  /** What it still waits on, at any depth (`requestWaitsOn`). */
  openSubtasks: number
  doneSubtasks: number
  cancelledSubtasks: number
  /** When its last sub-task closed; null while none has. */
  lastClosedAt: number | null
}

/** `main_closed`: the person's request it would be filed under has been closed. */
export type HandOffRefusal =
  'parent_not_found' | 'child_cap' | 'depth_cap' | 'root_rate_cap' | 'main_closed'

export type HandOffResult =
  | {
      ok: true
      task: BoardTask
      /** The hand-off made no task: this one was there already. `key` is a replay of
       *  this same hand-off, `title` is an open task with the same words. */
      deduplicated?: 'key' | 'title'
      /** The main task this create made (see `HandOffInput.mainTask`). */
      mainTask?: BoardTask
    }
  | {
      ok: false
      reason: HandOffRefusal | 'error'
      count?: number
      max?: number
      windowMs?: number
    }

export interface HandOffCapacity {
  room: number
  max: number
  reason: 'child_cap' | 'root_rate_cap'
}

/** A plan the engine wants in front of a person. */
export interface ProposePlanInput {
  teamId: string
  /** The agent proposing it: the one its answer goes back to. */
  agentId: string
  prompt: string
  steps: Array<{ title: string; description?: string; agentId: string; agentName: string }>
  /** The run's own task, when the plan comes from a run on one. */
  taskId: string | null
  /** Where the steps go when the plan has a card of its own. */
  parentTaskId: string | null
  /** The turn it came from: a replay of that turn finds its card. */
  turnId: string
  /** A batch of hand-offs rather than an ordered plan: accepted, its steps start at once. */
  parallel?: boolean
  /** The person's message this answers, when no task holds it yet: its main task lands
   *  with the card holding the plan, and the card and the accepted steps file under it. */
  mainTask?: MainTaskInput
  /** The one-to-one chat it came from: its card shows there, and the answer and the
   *  accepted steps' results go back there. */
  chatSessionKey?: string
}

export type PlanProposal =
  /** This team's plans start at once. Nothing was written. */
  | { status: 'off' }
  | {
      status: 'proposed'
      /** The task the plan waits on. */
      task: BoardTask
      /** It waits on a card of its own, not on the run's task. */
      holder: boolean
      /** The main task this proposal made (see `ProposePlanInput.mainTask`). */
      mainTask?: BoardTask
      /** The plan that was waiting, which this one took the place of. */
      replaced?: { title: string }
    }
  /** These same steps wait for a person already, or a person closed their card: nothing
   *  new, and nothing to say. */
  | { status: 'waiting' | 'closed'; taskId: string }
  /** A person already answered these same steps. `replay`: this very turn, seen again,
   *  so the agent has nothing new to hear. */
  | { status: 'already_accepted' | 'already_declined'; taskId: string; replay?: boolean }
  | { status: 'refused'; reason: string }
  | { status: 'error' }

/** What the team engine needs on top of the board: capped, repeat-safe creates, the
 *  chain the cycle guard reads, and the failure breaker. A browser has no use for
 *  these, so its client does not carry them. Same contract: never throws. */
export interface EngineBoardClient extends BoardClient {
  createHandOff(input: HandOffInput): Promise<HandOffResult>
  /** Would an automatic start of this task be refused at its job's limit? Ask this before
   *  a start with no claim: the start itself counts (`countJobRun`, `TurnOrigin.countJobs`).
   *  A refusal raises the job's card. */
  jobRunRefused(taskId: string): Promise<boolean>
  /** A person started work in this task's job, so it is no longer stopped. */
  personStartedJob(taskId: string): Promise<void>
  /** How many more of this team's tasks fit under this parent (null: at the root).
   *  `newRequest`: they go under a main task the first of them would make. Null when
   *  unread. */
  handOffRoom(
    teamId: string,
    parentTaskId: string | null,
    opts?: { newRequest?: boolean },
  ): Promise<HandOffCapacity | null>
  /** A task and its ancestors, nearest first. Null when unread. */
  handOffChain(taskId: string): Promise<HandOffLink[] | null>
  delegationFailure(
    teamId: string,
    targetAgentId: string,
    taskKey: string,
  ): Promise<{ failures: number; notified: boolean }>
  noteDelegationFailure(teamId: string, targetAgentId: string, taskKey: string): Promise<void>
  markDelegationFailureNotified(
    teamId: string,
    targetAgentId: string,
    taskKey: string,
  ): Promise<void>
  clearDelegationFailure(teamId: string, targetAgentId: string, taskKey: string): Promise<void>
  /** A task's sub-tasks, as `subtaskStanding` reads them. Null when unread. */
  subtasksOf(taskId: string): Promise<SubtaskView[] | null>
  /** What the agent of this run said about its task (`report_result`). Null for none. */
  resultClaim(execId: string): Promise<ResultClaim | null>
  /** End this task's wait on its sub-tasks if nothing more is coming from them: it goes
   *  back to the queue with a saved wake, or to a person. Nothing happens otherwise. */
  releaseSubtaskWait(taskId: string): Promise<void>
  /** Does the task runner run this task, rather than team chat? A room's Stop leaves it
   *  alone. True when unread, for the same reason. */
  runsOnTaskRunner(taskId: string): Promise<boolean>
  /** Does this team ask a person before a plan starts? False when unread: its plans run
   *  as they always did. A host with no such switch leaves these three out. */
  planApprovalOn?(teamId: string): Promise<boolean>
  /** Put a plan in front of a person, if this team asks first. */
  proposePlan?(input: ProposePlanInput): Promise<PlanProposal>
  /** Work is starting without asking, because the switch went off: a plan this agent has
   *  waiting is out of date. `proposePlan` does this itself when it answers `off`. Best-effort. */
  startingWithoutAsking?(input: {
    teamId: string
    agentId: string
    taskId: string | null
    parentTaskId: string | null
    chatSessionKey?: string
  }): Promise<void>
  /** A Stop closes the plans waiting in this team. Best-effort. */
  closeWaitingPlans?(teamId: string): Promise<void>
  /** Where a main task stands. Null for any other task, and when unread. */
  mainTaskState(taskId: string): Promise<MainTaskState | null>
  /** This room's open main tasks, oldest first. Empty when unread. */
  openMainTasks(teamId: string): Promise<MainTaskState[]>
  /** Close a request after its lead's summary. False when nothing moved. */
  closeMainTask(taskId: string, to: 'done' | 'cancelled'): Promise<boolean>
  /** Hand a request to a person, saying why: its summary never came. */
  parkMainTask(taskId: string, need: string): Promise<boolean>
  /** Back to waiting: a person said more on a parked request. */
  resumeMainTask(taskId: string): Promise<boolean>
}
