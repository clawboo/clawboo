// ─── Tasks MCP server ────────────────────────────────────────────────────────
// A thin protocol façade over the durable board repository (@clawboo/db). Lets
// ANY runtime coordinate on the same board. Atomic claim surfaces a conflict as
// a tool-error the model must NOT retry (the "never retry a 409" rule).

import {
  addComment,
  answerForAgent,
  askQuestion,
  appendEvent,
  blockTask,
  cancelDependents,
  clampAgentTaskPriority,
  claimTask,
  createCappedRootTask,
  createCappedSubtask,
  delegatorOf,
  deriveCreateKey,
  enqueueInbox,
  findHandOffCycle,
  getAncestors,
  getComments,
  getReadyTasks,
  getTask,
  getTaskDocument,
  handBackTask,
  handOffChain,
  isTaskIdentifier,
  isTeamLeadAgent,
  linkDep,
  listTasks,
  LOCAL_PERSON,
  openSubtasksOf,
  parseQuestionPayload,
  recordResultClaim,
  planApprovalOn,
  proposePlan,
  releaseTask,
  resolveTaskRef,
  saveAgentCommentWake,
  setTaskDelegator,
  TaskDependencyCycleError,
  TASK_DOCUMENT_MAX_CHARS,
  TASK_DOCUMENT_MAX_REVISIONS,
  taskStatusSchema,
  unblockTask,
  updateStatus,
  waitReaches,
  writeTaskDocument,
  type ClawbooDb,
  type CreatedTask,
  type CreateTaskInput,
  type DbTask,
  type EventActor,
  type DbTaskQuestion,
  type GuardedCreateResult,
  type AgentCommentWake,
  type QuestionAnswer,
  type QuestionKind,
  type QuestionPayload,
  type TaskStatus,
  type UpdateStatusResult,
  type WaitingOn,
} from '@clawboo/db'
import { z } from 'zod'

import { withInboxPiggyback } from '../piggyback'
import {
  buildServer,
  jsonResult,
  textResult,
  zodObjectToJsonSchema,
  type McpToolResult,
  type Server,
  type ToolDef,
} from '../shared'

// The tool schemas advertise exactly the statuses the board accepts. Derived from
// the shared state machine (@clawboo/board-core, re-exported by @clawboo/db) rather
// than hand-listed, so a status added server-side reaches MCP clients automatically.
const STATUS = taskStatusSchema

/** A status as the board labels it, for messages to the model. */
const STATUS_WORD: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
}

/**
 * The tool result for an agent's own status write. A person who moved the card
 * after this task's latest run started has the final word on it, so the refusal
 * tells the model to leave the status alone instead of retrying (the same
 * never-retry rule as a lost claim).
 */
function statusWriteResult(r: UpdateStatusResult, verb: string): McpToolResult {
  if (r.ok) return jsonResult(r.task)
  if (r.reason === 'person_moved') {
    const where = r.task ? (STATUS_WORD[r.task.status] ?? r.task.status) : 'another column'
    return textResult(
      `A person moved this task to ${where} after your run on it started, so its status is theirs to set. Leave it as it is and do not retry this call.`,
      true,
    )
  }
  if (r.reason === 'person_assigned')
    return textResult(
      'This task is assigned to a person, so its status is theirs to set. Leave it as it is and do not retry this call. To raise something about it, use add_comment.',
      true,
    )
  if (r.reason === 'awaiting_answer')
    return textResult(
      'This task is waiting for a person to answer a question, and the answer starts it again. Leave it as it is and do not retry this call. To raise something about it, use add_comment.',
      true,
    )
  if (r.reason === 'main_task')
    return textResult(
      "This task is a person's request, and it runs nothing by itself. It closes on its own once the work under it is in and the team lead has answered. Leave its status as it is and do not retry this call. To raise something about it, use add_comment.",
      true,
    )
  return textResult(`${verb} failed: ${r.reason}`, true)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** What became of a comment on a teammate's task, in words the model can act on: it
 *  must not stop and wait for someone a person has not allowed it to wake. */
function agentCommentWakeNote(
  wake: AgentCommentWake,
): { state: string; agent: string; note: string } | null {
  if (wake.state === 'none') return null
  return {
    state: wake.state,
    agent: wake.agentId,
    note:
      wake.state === 'declined'
        ? 'A person said agents do not wake each other on this job. It reads this in its next run on the task, whenever that is.'
        : 'It reads this in its next run on the task, whenever that is. Nothing tells a run going now, and a person may have to allow it before this starts anything. Do not wait for a reply.',
  }
}

/** Statuses a task only enters waiting for something, so an agent must say what. */
const WAITING_STATUSES = new Set(['blocked', 'in_review'])

/** The fields an agent says what its task waits for with. Flat, so every client's
 *  schema reader sees each one. */
const WAITING_FIELDS = {
  waitingOn: z.enum(['person', 'task', 'subtasks']).optional(),
  need: z.string().max(1_000).optional(),
  waitingOnTaskId: z.string().min(1).optional(),
}

/** The advertised schema with the waiting reason required. It stays optional in the
 *  zod schema so a call without it gets the refusal below, which says what to send,
 *  rather than a bare validation error. */
function requireWaitingOn(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const json = zodObjectToJsonSchema(schema)
  return { ...json, required: [...(json.required ?? []), 'waitingOn'] }
}

/** How a task's agent says what to wait for, as the refusal tells it. */
const WAITING_HOW =
  "Say what the task waits for: waitingOn 'person' with need (what the person must do), 'task' with waitingOnTaskId (a task that must finish first), or 'subtasks' (its own open sub-tasks)."
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Turn a capped-create denial into the tool error the model sees. The cap
 * messages name the recovery so the model can act instead of retrying — the same
 * spirit as the "never retry a 409" claim conflict.
 *
 * The caps bound what an ATTACHED RUNTIME can create through these tools. The
 * durable repository stays uncapped: the REST board and the in-process team-chat
 * orchestrator carry their own per-turn fan-out and dispatch-depth limits. Rows
 * they create still COUNT here, so an agent cannot launder rows in through
 * another surface to raise its own ceiling.
 */
function createDenial(result: GuardedCreateResult, parentTaskId?: string): McpToolResult {
  if (result.ok) throw new Error('createDenial called on a successful create')
  // Third arg = the typed `_meta.denied` channel. A cap refusal IS a policy
  // denial, so an in-process caller (the native harness) classifies it without
  // scraping prose, and a repeat offender trips the circuit breaker's
  // repeat-policy-denied rule instead of looping against the wall forever.
  if (result.reason === 'child_cap') {
    return textResult(
      `subtask rejected: parent ${parentTaskId} already has ${result.count} children (max ${result.max}). Finished and cancelled children still count, and only a person cancelling one frees a place. Attach the new task elsewhere, or tell the person.`,
      true,
      result.reason,
    )
  }
  if (result.reason === 'main_closed') {
    return textResult(
      `subtask rejected: ${parentTaskId} is part of a person's request that has closed. Do not add work to it.`,
      true,
      result.reason,
    )
  }
  if (result.reason === 'depth_cap') {
    return textResult(
      `subtask rejected: parent ${parentTaskId} is at the maximum nesting depth (${result.max}); attach the new task higher in the tree`,
      true,
      result.reason,
    )
  }
  if (result.reason === 'root_rate_cap') {
    const mins = Math.round((result.windowMs ?? 0) / 60_000)
    return textResult(
      `task rejected: ${result.count} root tasks already created in the last ${mins} min (max ${result.max}); attach this work to an existing task with parentTaskId instead of opening another`,
      true,
      result.reason,
    )
  }
  return textResult(`parent not found: ${parentTaskId}`, true, result.reason)
}

/** The arguments that name a task, and so take a readable id as well as an id. */
const TASK_REF_ARGS = ['taskId', 'parentTaskId', 'dependsOnTaskId', 'waitingOnTaskId'] as const

/**
 * A created task as the model reads it. A create that found its task already there
 * says so and names it, so the model works with that one. It does not say how a
 * second one could be made: the check exists to stop exactly that.
 */
function createdResult(task: CreatedTask): McpToolResult {
  if (!task.deduplicated) return jsonResult(task)
  const name = task.identifier ?? `"${task.title}"`
  const status = STATUS_WORD[task.status] ?? task.status
  return jsonResult({
    ...task,
    note:
      task.deduplicatedBy === 'title'
        ? `An open task with this title already exists under the same parent: ${name}, ${status}. No second task was made. This is that task.`
        : `This task was already created: ${name}, ${status}. No second task was made. This is that task.`,
  })
}

/**
 * Tell the agent that delegated a task that it was cancelled through these tools,
 * and how many of the plan steps waiting on it went with it. A person's cancel on
 * the board tells the delegator the same way. A cancel by the delegator itself
 * needs no note, and a task nobody delegated has nobody waiting on it. The row is
 * durable: it rides the delegator's next run or tool call.
 *
 * Returns the delegator when its note could not be written, so the caller can say
 * so, and null otherwise.
 */
function noteCancelForDelegator(
  db: ClawbooDb,
  task: DbTask,
  stepsCancelled: number,
  callerAgentId: string | undefined,
): string | null {
  const delegator = delegatorOf(task.sourceDelegationId)
  if (!delegator || delegator === callerAgentId) return null
  const steps =
    stepsCancelled === 0
      ? ''
      : stepsCancelled === 1
        ? ' One later step waiting on it was cancelled too.'
        : ` ${stepsCancelled} later steps waiting on it were cancelled too.`
  try {
    enqueueInbox(db, {
      agentId: delegator,
      teamId: task.teamId,
      kind: 'task_update',
      taskId: task.id,
      body: `“${task.title}” was cancelled through the Tasks tools.${steps} Do not hand it out again unless the work is still needed.`,
    })
    return null
  } catch {
    // The cancel itself is written; failing the tool call now would only make
    // the caller retry a cancel that already happened. The result says the note
    // is missing instead.
    return delegator
  }
}

/** Why an ask was refused, in words the model can act on. */
/** Why a routine's task never waits on a person, in words the model can act on. */
const ROUTINE_NO_WAIT =
  'This task comes from a scheduled routine, and its person may be away. Do not wait on them: make a reasonable assumption, say it in your reply, and finish.'

/** Why a report was refused, in words the model can act on. */
const REPORT_REFUSAL: Record<string, string> = {
  not_found: 'This task no longer exists.',
  not_yours: 'You are not working on this task, so it is not yours to report on.',
  no_run: 'There is no run open on this task, so there is nothing to report on.',
}

const ASK_REFUSAL: Record<string, string> = {
  not_found: 'This task no longer exists.',
  not_yours: 'You are not working on this task, so you cannot ask about it.',
  finished: 'This task is finished: there is no one to ask about it.',
  routine: ROUTINE_NO_WAIT,
  illegal_transition: 'This task cannot wait for an answer from where it is now.',
}

/** The most a plan's body may hold, as an agent reads it. */
const PLAN_MAX_WORDS = TASK_DOCUMENT_MAX_CHARS.toLocaleString('en-US')

const WRITE_PLAN_REFUSAL: Record<string, string> = {
  not_found: 'This task no longer exists.',
  not_yours: 'You are not working on this task, so its plan is not yours to write.',
  finished: 'This task is finished, so its plan is closed.',
  empty: 'write_plan needs body: the plan, as text.',
  too_long: `A plan can be at most ${PLAN_MAX_WORDS} characters. Shorten it, and leave the detail to the steps.`,
  too_many_revisions: `This task has had ${TASK_DOCUMENT_MAX_REVISIONS} revisions of its plan, the most it keeps. Carry on with the newest.`,
}

/** What an agent does after its question went in. */
const ASK_STOP =
  'The task now waits for the answer, so stop here: end your turn with one short line saying what you asked. When the person answers, the task starts again with their answer in it.'

/** A repeated `idempotencyKey`: the question is still open or was answered. One that
 *  closed unanswered freed its key, so that ask is a new question. */
function repeatedAskText(q: DbTaskQuestion): string {
  if (q.status === 'pending') return `You already asked this. ${ASK_STOP}`
  const prompt = parseQuestionPayload(q.payload)?.prompt ?? 'your question'
  let answer: QuestionAnswer | null = null
  try {
    answer = JSON.parse(q.answer ?? 'null') as QuestionAnswer | null
  } catch {
    // Unreadable: the thread still has it.
  }
  return answer
    ? `You already asked this, and a person answered. Carry on with their answer.\n${answerForAgent(prompt, answer)}`
    : 'You already asked this, and a person answered. Their answer is in the comments on this task: carry on with it.'
}

/** The board's read surface: the half that is safe to attach to an agent that
 *  must not mutate the board at all (a Clawboo Native team run). */
const READ_ONLY_TOOL_NAMES = new Set(['list_tasks', 'get_task'])
/** Served to a read-only team run as well: asking a person moves only the run's own
 *  task, and it is the only way such a run can wait for someone. Reporting moves
 *  nothing at all: it is evidence for the server's decision when the run ends. Its plan
 *  is a document on that task, which moves no card either. */
const ASK_TOOL_NAMES = new Set(['ask_person', 'report_result', 'write_plan'])
/** Tools whose ARGUMENTS name an agent, so an unidentified caller acts as anyone. */
const IDENTITY_TOOL_NAMES = new Set(['claim_task', 'assign_task'])
/** Tools that move a card: who may call them depends on who is calling. */
const STATUS_TOOL_NAMES = new Set([
  'release_task',
  'update_task_status',
  'block_task',
  'unblock_task',
  'ask_person',
  'hand_back_task',
])
/**
 * Not served on a team run. The team engine claims each task for its agent and
 * moves the card when the run ends: a model's `claim_task` would strand a card no
 * recovery pass can reach, and its own `update_task_status(done)` would read to
 * the engine as a person finishing the task, so the delegator would never get
 * the result.
 * `block_task` stays, for the agent's own task only: the engine reports a run
 * that blocked its task to the delegator.
 */
const TEAM_RUN_WITHHELD_TOOL_NAMES = new Set([
  'claim_task',
  'assign_task',
  'release_task',
  'update_task_status',
  'unblock_task',
])

export interface TasksServerOptions {
  /** Serve only {@link READ_ONLY_TOOL_NAMES} — board reads, no mutations. */
  readOnly?: boolean
  /**
   * The run's authoritative team, bound by clawboo at attach time — the Tasks
   * analog of the Memory server's `boundScope` and TeamChat's `boundIdentity`.
   * When set, `list_tasks` is forced to this team (the model's own `teamId` arg
   * is ignored, so it can't widen its visibility) and `get_task` refuses a task
   * belonging to another team.
   *
   * Load-bearing for more than isolation: the team preamble never tells an agent
   * its own teamId, so an agent told to "check the board before you start" calls
   * `list_tasks` with no argument. Unbound, that returns every team's tasks —
   * the opposite of the "don't duplicate a teammate's work" purpose. Bound, the
   * bare call is exactly right.
   *
   * Omitted — or a null/absent `teamId`, i.e. a run with no team at all ⇒
   * board-wide (the raw stdio bin / an external attach / a teamless task).
   *
   * `agentId` (when bound) additionally enables the mid-run inbox piggyback:
   * the calling agent's undelivered mailbox rows ride each tool response.
   *
   * `taskId` (when bound) is the task the run works on. `get_task`,
   * `add_comment` and `block_task` use it when a call leaves `taskId` out, so an
   * agent reads its own task's history without having to find the id first. A
   * default only: it widens nothing, and every other guard still applies.
   *
   * `executionId` (when bound) is the run's execution row, recorded with the
   * agent on each write this session makes.
   */
  boundScope?: {
    teamId?: string | null
    agentId?: string | null
    taskId?: string | null
    executionId?: string | null
  }

  /**
   * The caller reached us over a transport that CAN carry a verified scope and
   * did NOT. Distinct from `boundScope` being unset, which means the operator ran
   * the stdio bin themselves; see the Memory server's `unverifiedCaller` for the
   * full reasoning, which applies here identically.
   *
   * Effect: the two tools that take an agent id as an ARGUMENT are not served,
   * and `add_comment` drops BOTH its `authorAgentId` and its `authorType`. Those
   * are the impersonation surface here: `claim_task` and `assign_task` require
   * `assigneeAgentId`, so an unidentified caller could claim work as anyone and
   * hand work to anyone, and a comment's `authorType` is rendered to the operator
   * as its attribution.
   *
   * The status tools are not served either. Every OpenClaw agent is this caller,
   * on one URL shared by all of its sessions, so nothing can tell a team run from
   * a 1:1 chat or an agent's own task from a teammate's, and an OpenClaw agent
   * marking its delegated task done would cost its delegator the result (see
   * `teamRun`). Creates, comments and links stay: they move no card.
   */
  unverifiedCaller?: boolean

  /**
   * The run is one the team engine drives, signed on the attach URL
   * (`teamRun=1`). The engine owns claims and statuses there, so the tools in
   * `TEAM_RUN_WITHHELD_TOOL_NAMES` are not served, and `block_task` blocks only a
   * task the bound agent is working on.
   */
  teamRun?: boolean

  /**
   * Is this agent a lead of the team? A hand-off to a lead is an escalation, which
   * the cycle guard lets through. Defaults to the team's own lead; the server adds
   * Boo Zero, which leads every team.
   */
  isLeadAgent?: (teamId: string | null, agentId: string) => boolean
}

export function createTasksServer(db: ClawbooDb, opts?: TasksServerOptions): Server {
  // Normalize null → undefined so "no team" reads as unbound everywhere below.
  const boundTeamId = opts?.boundScope?.teamId ?? undefined
  /**
   * Refuse a WRITE to a task outside the bound team.
   *
   * `boundScope.teamId` guarded `list_tasks` and `get_task` and nothing else, so
   * on a bound session served without `readOnly` a model could claim, release,
   * re-status, block, comment on or link another team's task by guessing an id —
   * while `get_task` refused to show it the same id. Reads were isolated and
   * writes were board-wide.
   *
   * Returns the SAME "not found" as a read, so the guard leaks nothing: a bound
   * run cannot tell a hidden task from an absent one by probing either surface.
   */
  const outOfTeam = (taskId: string): McpToolResult | null => {
    if (!boundTeamId) return null
    const t = getTask(db, taskId)
    if (t && t.teamId === boundTeamId) return null
    return textResult(`not found: ${taskId}`, true)
  }

  // The calling agent, when its identity is bound. Over HTTP only a signed scope
  // binds it; in-process (Clawboo Native) the driver binds it.
  const boundAgentId = opts?.boundScope?.agentId ?? undefined
  const teamRun = opts?.teamRun === true
  // The run's own task, when bound: the default for the one-task tools below.
  const boundTaskId = opts?.boundScope?.taskId ?? undefined
  // Optional when a task is bound, but never empty: "" would read as "my task".
  const taskIdField = boundTaskId ? z.string().min(1).optional() : z.string()
  /** The task a one-task tool acts on: the named one, else the run's own. */
  const taskOf = (args: Record<string, unknown>): string =>
    optStr(args['taskId']) || boundTaskId || ''
  /** Appended to a one-task tool's description when a task is bound. */
  const ownTaskHint = (verb: string): string =>
    boundTaskId ? ` Leave out taskId to ${verb} the task you are working on.` : ''
  // The run behind this session's writes, when it has one.
  const boundExecutionId = opts?.boundScope?.executionId ?? undefined
  // Who this session's writes are recorded as. Only a verified or in-process
  // binding names an agent. Any other caller says nothing about who it is, and an
  // OpenClaw agent cannot say more: its URL is unsigned and process-wide.
  const actor: EventActor = boundAgentId
    ? { kind: 'agent', agentId: boundAgentId, execId: boundExecutionId ?? null }
    : { kind: 'caller' }
  /** Record a write in the event log, with who made it. Best-effort: the log must
   *  never fail the write it describes. Written here rather than by a host, so the
   *  stdio bin's writes are recorded too. */
  const recordWrite = (
    kind: 'task_created' | 'task_claimed' | 'status_changed' | 'comment_added' | 'dep_linked',
    task: Pick<DbTask, 'id' | 'teamId' | 'assigneeAgentId'> | null | undefined,
    data: Record<string, unknown>,
  ): void => {
    if (!task) return
    try {
      appendEvent(db, {
        kind,
        taskId: task.id,
        teamId: task.teamId,
        agentId: task.assigneeAgentId ?? boundAgentId ?? null,
        data: { ...data, actor },
      })
    } catch {
      /* best-effort */
    }
  }
  /** A status write's event, when the write happened. */
  const recordStatus = (r: UpdateStatusResult, to: TaskStatus): void => {
    if (r.ok) recordWrite('status_changed', r.task, { to })
  }
  /** A create's event, unless it found its task already there: nothing was written. */
  const recordCreate = (result: GuardedCreateResult, parentTaskId?: string): void => {
    if (!result.ok || result.task.deduplicated) return
    recordWrite('task_created', result.task, {
      title: result.task.title,
      status: result.task.status,
      parentTaskId: parentTaskId ?? null,
    })
  }

  const isLead = opts?.isLeadAgent ?? ((teamId, agentId) => isTeamLeadAgent(db, teamId, agentId))

  /**
   * The create's idempotency key. A key the caller named is the model's own word, so
   * it only means this create from this caller: kept to the run's task, else the agent,
   * else the team, and to this parent and title. Agent B's `subtask-1` is not agent A's.
   *
   * With none, the key comes from the run's task, the parent and the title, so a run
   * that makes a sub-task twice gets one, even once it has finished. A caller with no
   * bound task (an OpenClaw session, a lead's chat turn) falls back to the team, which
   * speaks for every teammate's create, so it matches only a task still open: Monday's
   * finished digest is not what Tuesday's create is asking for.
   */
  const createKeyFor = (
    args: Record<string, unknown>,
    teamId: string | null | undefined,
    parentTaskId: string | undefined,
  ): CreateTaskInput['createKey'] => {
    const title = str(args['title'])
    const parent = parentTaskId ?? ''
    const named = optStr(args['idempotencyKey'])
    if (named) {
      const owner = boundTaskId
        ? ['task', boundTaskId]
        : boundAgentId
          ? ['agent', boundAgentId]
          : ['team', teamId ?? '']
      return { key: deriveCreateKey(['mcp', ...owner, parent, named], title).key }
    }
    if (boundTaskId) return deriveCreateKey(['mcp-task', boundTaskId, parent], title)
    return { ...deriveCreateKey(['mcp-team', teamId ?? '', parent], title), openOnly: true }
  }

  /** The refusal for a hand-off that would go back to an agent waiting on this
   *  work, or null. See `findHandOffCycle`. A lead is exempt, and handing a task to
   *  yourself hands nothing off. */
  const handOffRefusal = (taskId: string, targetAgentId: string): McpToolResult | null => {
    if (targetAgentId === boundAgentId) return null
    if (isLead(getTask(db, taskId)?.teamId ?? null, targetAgentId)) return null
    const cycle = findHandOffCycle(handOffChain(db, taskId), targetAgentId, {
      ownTaskId: boundTaskId ?? null,
    })
    if (!cycle) return null
    const name = cycle.identifier ?? `"${cycle.title}"`
    return textResult(
      `Not handed off: ${targetAgentId} handed out ${name}, which is still open, so this cannot go back to them. Each would wait on the other. Finish your part and report back; for a blocker, go to the team lead.`,
      true,
      'hand_off_cycle',
    )
  }
  // The task `ask_person` and `hand_back_task` act on: the run's own, where its end
  // is handled as an agent's block. Without one they are not served, because no run
  // would be woken by the answer.
  const ownTask = teamRun && boundTaskId && boundAgentId ? boundTaskId : undefined
  // The task `write_plan` writes on: only ever the one signed on the run's URL, for the
  // agent signed with it.
  const planTask = boundTaskId && boundAgentId ? boundTaskId : undefined

  /**
   * What a task waits for, from an agent's arguments, or the refusal that tells the
   * model what to send. It refuses what could not end as things stand: a task on this
   * team that is finished, is this one, is in the Backlog (nothing starts it), or needs
   * this one to finish first; and sub-tasks when none is open, one is in the Backlog,
   * or they need this one to finish first. A check at the moment of the wait: what
   * people do to that work afterwards is theirs to do.
   */
  const waitingFrom = (
    taskId: string,
    args: Record<string, unknown>,
  ): { waitingOn: WaitingOn } | { refusal: McpToolResult } => {
    const kind = optStr(args['waitingOn'])
    const refuse = (why: string) => ({ refusal: textResult(why, true) })
    const EACH_OTHER =
      'Those tasks would wait on each other, so neither would ever start. Wait on something else.'
    const NOT_STARTED = (what: string) =>
      `${what} in the backlog, and nothing starts work from there, so this would never end. Move it to todo first, or wait on something else.`
    if (!kind) return refuse(`This task would wait without a reason. ${WAITING_HOW}`)
    if (kind === 'person') {
      const need = str(args['need']).trim()
      if (!need)
        return refuse(`waitingOn 'person' needs need: what the person must do. ${WAITING_HOW}`)
      return { waitingOn: { kind: 'person', need, by: 'agent' } }
    }
    if (kind === 'subtasks') {
      const open = openSubtasksOf(db, taskId)
      if (open.length === 0)
        return refuse(
          'This task has no open sub-tasks to wait on. Create them first, or wait on something else.',
        )
      if (open.some((s) => s.status === 'backlog'))
        return refuse(NOT_STARTED('One of its sub-tasks is'))
      if (
        waitReaches(
          db,
          open.map((s) => s.id),
          taskId,
        )
      )
        return refuse(EACH_OTHER)
      return { waitingOn: { kind: 'subtasks' } }
    }
    const target = optStr(args['waitingOnTaskId']) ?? ''
    if (!target) return refuse(`waitingOn 'task' needs waitingOnTaskId. ${WAITING_HOW}`)
    const denied = outOfTeam(target)
    if (denied) return { refusal: denied }
    if (target === taskId) return refuse('A task cannot wait on itself.')
    const t = getTask(db, target)
    if (!t || t.dropped) return refuse(`not found: ${target}`)
    if (t.status === 'done' || t.status === 'cancelled')
      return refuse(`That task is already ${STATUS_WORD[t.status]}: there is nothing to wait for.`)
    if (t.status === 'backlog') return refuse(NOT_STARTED('That task is'))
    if (waitReaches(db, [target], taskId)) return refuse(EACH_OTHER)
    return { waitingOn: { kind: 'task', taskId: target } }
  }

  const blockSchema = z.object({
    taskId: taskIdField,
    ...WAITING_FIELDS,
  })

  const claimFor = (args: Record<string, unknown>, assigneeAgentId: string): McpToolResult => {
    const denied = outOfTeam(str(args['taskId']))
    if (denied) return denied
    const result = claimTask(
      db,
      str(args['taskId']),
      assigneeAgentId,
      optStr(args['assigneeRuntime']),
    )
    if (result.reason === 'person_assigned')
      return textResult(
        'claim failed: this task is assigned to a person, so no agent takes it. Do not retry.',
        true,
      )
    if (!result.ok) return textResult(`claim failed: ${result.reason}`, true) // conflict → DO NOT retry
    recordWrite('task_claimed', result.task, {
      assigneeAgentId: result.task?.assigneeAgentId ?? assigneeAgentId,
      assigneeRuntime: result.task?.assigneeRuntime ?? null,
    })
    return jsonResult(result.task)
  }
  const assignSchema = z.object({
    taskId: z.string(),
    assigneeAgentId: z.string(),
    assigneeRuntime: z.string().optional(),
  })
  // A bound caller claims as itself, so it need not name anyone. The operator's
  // stdio bin has no identity of its own and names the agent it claims for.
  const claimSchema = boundAgentId
    ? z.object({
        taskId: z.string(),
        assigneeAgentId: z.string().optional(),
        assigneeRuntime: z.string().optional(),
      })
    : assignSchema

  const tools: ToolDef[] = [
    {
      name: 'list_tasks',
      description: boundTeamId
        ? "List your team's board tasks. Pass ready=true for only claimable (deps satisfied) work."
        : 'List board tasks. Pass ready=true for only claimable (deps satisfied) work.',
      inputSchema: z.object({
        teamId: z.string().optional(),
        status: STATUS.optional(),
        ready: z.boolean().optional(),
      }),
      handler: (args) => {
        // The binding wins outright: a bound run's `teamId` arg is ignored, so
        // the model can neither widen past its team nor probe another one (the
        // same anti-spoof semantic as TeamChat's bound identity).
        const teamId = boundTeamId ?? optStr(args['teamId'])
        const tasks =
          args['ready'] === true
            ? getReadyTasks(db, { teamId })
            : listTasks(db, { teamId, status: optStr(args['status']) as TaskStatus | undefined })
        return jsonResult(tasks)
      },
    },
    {
      name: 'get_task',
      description: `Get a task with its comments and ancestor chain. taskId here and on every tool takes the id or the readable id, like CLB-12.${ownTaskHint('read')}`,
      inputSchema: z.object({ taskId: taskIdField }),
      handler: (args) => {
        const id = taskOf(args)
        const task = getTask(db, id)
        if (!task) return textResult(`not found: ${id}`, true)
        // Out-of-team reads are refused as not-found: a bound run must not be
        // able to probe another team's board by guessing ids.
        if (boundTeamId && task.teamId !== boundTeamId) return textResult(`not found: ${id}`, true)
        const plan = getTaskDocument(db, id)
        return jsonResult({
          task,
          comments: getComments(db, id),
          ancestors: getAncestors(db, id),
          ...(plan ? { plan: { revision: plan.revision, body: plan.body } } : {}),
        })
      },
    },
    {
      name: 'create_task',
      description:
        'Create a board task. With parentTaskId set it is a subtask: the per-parent child-count and nesting-depth caps apply. Without one it is a root task, rate-limited per rolling window. priority: 1 high, 0 normal (the default), -1 low; only a person can make a task urgent, and any other number is held to that range. A task is made once: repeating a create, or creating an open task with the same title under the same parent within 48 hours, returns the existing task with deduplicated: true. Pass idempotencyKey to name a create, so a retry of it by you, with this title and parent, returns the same task.',
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        status: STATUS.optional(),
        priority: z.number().int().optional(),
        teamId: z.string().optional(),
        // .min(1) so '' is an "invalid args" tool error rather than an empty-string
        // parent that reaches the FK and throws out of the handler. Wire-invisible:
        // the zod→JSON-Schema converter emits { type: 'string' } either way.
        parentTaskId: z.string().min(1).optional(),
        assigneeRuntime: z.string().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        ...WAITING_FIELDS,
      }),
      handler: (args) => {
        // A task born waiting says what for, as a status move must.
        let waitingOn: WaitingOn | undefined
        if (WAITING_STATUSES.has(str(args['status']))) {
          const kind = optStr(args['waitingOn'])
          if (kind !== 'person')
            return textResult(
              `A task created ${STATUS_WORD[str(args['status'])]} must say what it waits for: waitingOn 'person' with need (what the person must do).`,
              true,
            )
          const w = waitingFrom('', args)
          if ('refusal' in w) return w.refusal
          waitingOn = w.waitingOn
        }
        // A bound session creates INTO ITS TEAM, full stop. The caller's teamId
        // was honoured verbatim, so a bound model could create into any team by
        // naming it: the one write the outOfTeam guard below cannot catch,
        // because the task does not exist yet. Membership in the team is the
        // binding's decision, not the argument's.
        const teamId = boundTeamId ?? optStr(args['teamId'])
        // No parent ⇒ a ROOT task, bounded by a rolling-window rate cap instead
        // (a per-parent ceiling has no subject there).
        const parentTaskId = optStr(args['parentTaskId'])
        const input: Omit<CreateTaskInput, 'parentTaskId'> = {
          title: str(args['title']),
          description: optStr(args['description']),
          status: optStr(args['status']) as TaskStatus | undefined,
          // Urgent is a person's call; see clampAgentTaskPriority.
          priority:
            typeof args['priority'] === 'number'
              ? clampAgentTaskPriority(args['priority'])
              : undefined,
          teamId,
          assigneeRuntime: optStr(args['assigneeRuntime']),
          ...(waitingOn ? { waitingOn } : {}),
          agentCreated: true,
          delegatedByAgentId: boundAgentId ?? null,
          createKey: createKeyFor(
            args,
            teamId ?? (parentTaskId ? getTask(db, parentTaskId)?.teamId : null),
            parentTaskId,
          ),
        }
        // A subtask INHERITS its parent's team, so a parent outside the binding
        // is a cross-team write wearing a create's clothes.
        if (parentTaskId) {
          const denied = outOfTeam(parentTaskId)
          if (denied) return denied
        }
        const result = parentTaskId
          ? createCappedSubtask(db, parentTaskId, input)
          : createCappedRootTask(db, input)
        recordCreate(result, parentTaskId)
        return result.ok ? createdResult(result.task) : createDenial(result, parentTaskId)
      },
    },
    {
      name: 'create_subtask',
      description:
        'Create a subtask under a parent (inherits the parent team). Capped per parent (child count) and by nesting depth. A task is made once: repeating a create, or creating an open task with the same title under the same parent within 48 hours, returns the existing task with deduplicated: true.',
      inputSchema: z.object({
        parentTaskId: z.string().min(1),
        title: z.string(),
        description: z.string().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      }),
      handler: (args) => {
        const parentTaskId = str(args['parentTaskId'])
        // The same inheritance escape `create_task` guards against: the subtask
        // takes its parent's team, so a foreign parent is a cross-team write. This
        // tool was missed when that guard went in.
        const denied = outOfTeam(parentTaskId)
        if (denied) return denied
        const result = createCappedSubtask(db, parentTaskId, {
          title: str(args['title']),
          description: optStr(args['description']),
          agentCreated: true,
          delegatedByAgentId: boundAgentId ?? null,
          createKey: createKeyFor(
            args,
            boundTeamId ?? getTask(db, parentTaskId)?.teamId,
            parentTaskId,
          ),
        })
        recordCreate(result, parentTaskId)
        return result.ok ? createdResult(result.task) : createDenial(result, parentTaskId)
      },
    },
    {
      name: 'claim_task',
      description: boundAgentId
        ? 'Atomically claim a todo task for yourself. A "conflict" error means another agent won, so do not retry. To hand a task to another agent, use assign_task.'
        : 'Atomically claim a todo task for an agent. A "conflict" error means another agent won, so do not retry.',
      inputSchema: claimSchema,
      handler: (args) => {
        const named = optStr(args['assigneeAgentId'])
        if (!boundAgentId) return claimFor(args, str(named))
        // The claimant is the verified caller. Taking it from the arguments let
        // one agent claim work in another's name.
        if (named !== undefined && named !== boundAgentId)
          return textResult(
            `claim_task claims a task for you (${boundAgentId}), not for ${named}. To hand a task to another agent, use assign_task.`,
            true,
          )
        return claimFor(args, boundAgentId)
      },
    },
    {
      name: 'assign_task',
      description:
        'Assign a todo task to an agent (same atomic claim; conflict means already assigned). A task cannot go back to an agent that handed out one of its open parents, except the team lead.',
      inputSchema: assignSchema,
      handler: (args) => {
        const taskId = str(args['taskId'])
        const target = str(args['assigneeAgentId'])
        const denied = outOfTeam(taskId) ?? handOffRefusal(taskId, target)
        if (denied) return denied
        const result = claimFor(args, target)
        // Who handed it out, for the guard on whatever comes back down this chain.
        if (!result.isError && boundAgentId && boundAgentId !== target) {
          setTaskDelegator(db, taskId, boundAgentId)
        }
        return result
      },
    },
    {
      name: 'release_task',
      description: 'Release an in-progress task back to todo.',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        const denied = outOfTeam(str(args['taskId']))
        if (denied) return denied
        const before = getTask(db, str(args['taskId']))
        if (before?.isMainTask === 1)
          return statusWriteResult({ ok: false, reason: 'main_task' }, 'release')
        releaseTask(db, str(args['taskId']))
        if (before?.status === 'in_progress')
          recordWrite('status_changed', getTask(db, before.id), { to: 'todo', reason: 'released' })
        return textResult(`released: ${str(args['taskId'])}`)
      },
    },
    {
      name: 'update_task_status',
      description:
        "Transition a task status (state-machine enforced; illegal transitions error). Cancelling a task also cancels the plan steps still waiting on it. Moving it to blocked or in_review needs waitingOn: 'person' with need, 'task' with waitingOnTaskId, or 'subtasks'.",
      inputSchema: z.object({ taskId: z.string(), status: STATUS, ...WAITING_FIELDS }),
      handler: (args) => {
        const taskId = str(args['taskId'])
        const denied = outOfTeam(taskId)
        if (denied) return denied
        const status = str(args['status']) as TaskStatus
        let waitingOn: WaitingOn | undefined
        if (WAITING_STATUSES.has(status)) {
          const w = waitingFrom(taskId, args)
          if ('refusal' in w) return w.refusal
          // In review means someone is reviewing it. Nothing ends a wait on other work
          // from there: the board moves a task on only from Blocked.
          if (status === 'in_review' && w.waitingOn.kind !== 'person')
            return textResult(
              "A task waiting on another task or on its sub-tasks goes to blocked, not in_review, so the board can move it on when that work finishes. Use status 'blocked', or waitingOn 'person' with need for in_review.",
              true,
            )
          waitingOn = w.waitingOn
        }
        const r = updateStatus(db, taskId, status, {
          unlessPersonMoved: true,
          ...(waitingOn ? { waitingOn } : {}),
        })
        recordStatus(r, status)
        if (!r.ok || !r.task || status !== 'cancelled') return statusWriteResult(r, 'status change')
        // A cancelled step can never be done, so the steps waiting on it would
        // sit in To do forever, looking queued. The same cascade as a person's
        // cancel on the board. Run on a repeated cancel too, which finishes a
        // cascade an earlier call did not: it moves only steps still waiting.
        const dependents = cancelDependents(db, taskId)
        // `from` is read in the cancel's own write, so of two cancels racing, only
        // the one that moved the task tells the delegator.
        const unnoted =
          r.from !== 'cancelled' || dependents.length > 0
            ? noteCancelForDelegator(db, r.task, dependents.length, boundAgentId)
            : null
        if (dependents.length === 0 && !unnoted) return jsonResult(r.task)
        return jsonResult({
          ...r.task,
          ...(dependents.length > 0
            ? { cancelledDependents: dependents.map((d) => ({ id: d.id, title: d.title })) }
            : {}),
          // The agent that delegated the task, when its mailbox note could not
          // be written: the cancel stands, but nobody told it.
          ...(unnoted ? { delegatorNotTold: unnoted } : {}),
        })
      },
    },
    {
      name: 'block_task',
      // The team engine and the task runner both end a run whose agent blocked its
      // own task as that agent's call, with its reply kept and the delegator told.
      description: teamRun
        ? `Mark the task you are working on blocked, when it cannot go on until something else happens. ${WAITING_HOW}${ownTask ? ' To ask a person a question, use ask_person instead.' : ''}${boundTaskId ? ' Leave out taskId to block it.' : ''}`
        : `Mark a task blocked. ${WAITING_HOW}${boundTaskId ? ' Leave out taskId to block the task you are working on, and say why in your reply.' : ''}`,
      inputSchema: blockSchema,
      jsonSchema: requireWaitingOn(blockSchema),
      handler: (args) => {
        const taskId = taskOf(args)
        const denied = outOfTeam(taskId)
        if (denied) return denied
        if (teamRun && getTask(db, taskId)?.assigneeAgentId !== boundAgentId)
          return textResult(
            'On a team run, block_task blocks only the task you are working on. To raise a problem with another task, use add_comment on it.',
            true,
          )
        const w = waitingFrom(taskId, args)
        if ('refusal' in w) return w.refusal
        const r = blockTask(db, taskId, { unlessPersonMoved: true, waitingOn: w.waitingOn })
        recordStatus(r, 'blocked')
        return statusWriteResult(r, 'block')
      },
    },
    ...(ownTask
      ? [
          {
            name: 'ask_person',
            description:
              "Ask a person something you cannot decide or find out yourself, about the task you are working on, then stop. kind 'question' with options (and allowOther for free text), or none for free text; 'confirm' for a yes or no; 'suggest_tasks' with tasks, a breakdown they accept or edit. The task waits for the answer, and you are started again with it. Do not ask what you can reasonably assume.",
            inputSchema: z.object({
              taskId: z.string().min(1).optional(),
              kind: z.enum(['question', 'confirm', 'suggest_tasks']),
              question: z.string().min(1).max(2_000),
              options: z.array(z.string().min(1).max(200)).max(8).optional(),
              allowOther: z.boolean().optional(),
              tasks: z.array(z.string().min(1).max(200)).max(12).optional(),
              idempotencyKey: z.string().min(1).max(200).optional(),
            }),
            handler: (args: Record<string, unknown>): McpToolResult => {
              const named = optStr(args['taskId'])
              if (named && named !== ownTask)
                return textResult(
                  'ask_person asks only about the task you are working on. To raise something about another task, use add_comment on it.',
                  true,
                )
              const kind = str(args['kind']) as QuestionKind
              const options = Array.isArray(args['options']) ? (args['options'] as string[]) : []
              const tasks = Array.isArray(args['tasks']) ? (args['tasks'] as string[]) : []
              if (kind === 'suggest_tasks' && tasks.length === 0)
                return textResult("kind 'suggest_tasks' needs tasks: the titles you propose.", true)
              const payload: QuestionPayload = {
                prompt: str(args['question']),
                ...(kind === 'question' && options.length > 0 ? { options } : {}),
                ...(kind === 'question' && args['allowOther'] === true ? { allowOther: true } : {}),
                ...(kind === 'suggest_tasks' ? { tasks: tasks.map((title) => ({ title })) } : {}),
              }
              // On a team that asks before a plan starts, a proposed breakdown is a plan:
              // accepting it creates the tasks.
              const teamOfTask = getTask(db, ownTask)?.teamId
              if (kind === 'suggest_tasks' && teamOfTask && planApprovalOn(db, teamOfTask)) {
                const proposed = proposePlan(db, {
                  teamId: teamOfTask,
                  agentId: boundAgentId ?? '',
                  prompt: payload.prompt,
                  steps: payload.tasks ?? [],
                  taskId: ownTask,
                  parentTaskId: null,
                  holderAllowed: false,
                  executionId: boundExecutionId ?? null,
                })
                if (proposed.status === 'proposed')
                  return textResult(
                    `Asked. If they accept, the tasks are created for you and start in order, so do not create them yourself. ${ASK_STOP}`,
                  )
                if (proposed.status === 'waiting')
                  return textResult(`You already asked this. ${ASK_STOP}`)
                if (proposed.status === 'already_accepted')
                  return textResult(
                    'A person already accepted this breakdown, and its tasks are on the board. Do not create them again.',
                  )
                if (proposed.status === 'already_declined')
                  return textResult(
                    'A person already turned this breakdown down. Change it before you ask again, or carry on without it.',
                    true,
                  )
                if (proposed.status === 'refused') {
                  if (proposed.reason === 'person_moved')
                    return statusWriteResult(
                      {
                        ok: false,
                        reason: 'person_moved',
                        ...(proposed.task ? { task: proposed.task } : {}),
                      },
                      'ask',
                    )
                  return textResult(
                    proposed.reason === 'too_deep'
                      ? 'This task is already as deep as tasks go, so it cannot be split further. Do the work here, or report back.'
                      : (ASK_REFUSAL[proposed.reason] ?? `ask failed: ${proposed.reason}`),
                    true,
                  )
                }
              }
              const r = askQuestion(db, {
                taskId: ownTask,
                agentId: boundAgentId ?? '',
                kind,
                payload,
                idempotencyKey: optStr(args['idempotencyKey']) ?? null,
                executionId: boundExecutionId ?? null,
              })
              if (r.ok && r.existing) return textResult(repeatedAskText(r.question))
              if (r.ok) return textResult(`Asked. ${ASK_STOP}`)
              if (r.reason === 'person_moved')
                return statusWriteResult({ ok: false, reason: 'person_moved', task: r.task }, 'ask')
              return textResult(ASK_REFUSAL[r.reason] ?? `ask failed: ${r.reason}`, true)
            },
          },
          {
            name: 'report_result',
            description:
              "Say how the task you are working on went, before you end your turn. outcome 'done': the work is finished. outcome 'not_done': it is not, and summary says why and what a person should do next. A report, not a move: it changes no status, and the board decides when your run ends. Reporting done does not get past a failed check. Optional: if you do not call it, your reply is the report. To wait on something, use ask_person, hand_back_task or block_task instead.",
            inputSchema: z.object({
              taskId: z.string().min(1).optional(),
              outcome: z.enum(['done', 'not_done']),
              summary: z.string().min(1).max(4_000),
              deliverables: z.array(z.string().min(1).max(500)).max(20).optional(),
            }),
            handler: (args: Record<string, unknown>): McpToolResult => {
              const named = optStr(args['taskId'])
              if (named && named !== ownTask)
                return textResult(
                  'report_result reports only on the task you are working on. To raise something about another task, use add_comment on it.',
                  true,
                )
              const summary = str(args['summary']).trim()
              if (!summary)
                return textResult('report_result needs summary: what you did, or why not.', true)
              const deliverables = Array.isArray(args['deliverables'])
                ? (args['deliverables'] as string[])
                : []
              const outcome = str(args['outcome']) === 'done' ? 'done' : 'not_done'
              const r = recordResultClaim(
                db,
                ownTask,
                boundAgentId ?? '',
                { outcome, summary, ...(deliverables.length > 0 ? { deliverables } : {}) },
                { executionId: boundExecutionId ?? null },
              )
              if (!r.ok) return textResult(REPORT_REFUSAL[r.reason] ?? r.reason, true)
              // Who said it and on which run, from the binding. Never its words: the log is
              // read more widely than the run's row. A report moves nothing, so `to` is
              // where the task still is, as for a wait that changed without a move.
              const reported = getTask(db, ownTask)
              if (reported)
                recordWrite('status_changed', reported, {
                  to: reported.status,
                  reason: 'result_reported',
                  outcome,
                })
              return textResult(
                'Noted. This is a report: the board decides when your run ends. Finish your turn with your reply as usual.',
              )
            },
          },
          {
            name: 'hand_back_task',
            description:
              'Hand the task you are working on back to the person who asked for it, when the next step is theirs to take (a login only they have, a decision, a physical action). need says exactly what they must do. Then stop.',
            inputSchema: z.object({
              taskId: z.string().min(1).optional(),
              need: z.string().max(1_000).optional(),
            }),
            // Advertised as required; a call without it gets the refusal below.
            jsonSchema: zodObjectToJsonSchema(
              z.object({ taskId: z.string().min(1).optional(), need: z.string() }),
            ),
            handler: (args: Record<string, unknown>): McpToolResult => {
              const named = optStr(args['taskId'])
              if (named && named !== ownTask)
                return textResult(
                  'hand_back_task hands back only the task you are working on.',
                  true,
                )
              const need = str(args['need']).trim()
              if (!need)
                return textResult('hand_back_task needs need: what the person must do.', true)
              const r = handBackTask(db, ownTask, {
                agentId: boundAgentId ?? '',
                need,
                executionId: boundExecutionId ?? null,
              })
              if (r.ok) {
                // The built-in person's name is "You", which reads as the agent itself.
                const who =
                  r.person.id === LOCAL_PERSON.id
                    ? 'the person who asked'
                    : (r.person.name ?? 'the person who asked')
                return textResult(
                  `Handed back to ${who}. Stop here: end your turn with one short line saying what they need to do.`,
                )
              }
              if (r.reason === 'person_moved')
                return statusWriteResult(
                  { ok: false, reason: 'person_moved', task: r.task },
                  'hand back',
                )
              return textResult(
                r.reason === 'not_yours'
                  ? 'You are not working on this task, so it is not yours to hand back.'
                  : r.reason === 'routine'
                    ? ROUTINE_NO_WAIT
                    : `hand back failed: ${r.reason}`,
                true,
              )
            },
          },
        ]
      : []),
    ...(planTask
      ? [
          {
            name: 'write_plan',
            description: `Write or revise the plan for the task you are working on: a document people read on the task, and your later runs read in their ticket. Each call is a new revision, and earlier ones stay readable. At most ${PLAN_MAX_WORDS} characters. Writing a plan starts nothing and asks no one.`,
            inputSchema: z.object({ body: z.string() }),
            handler: (args: Record<string, unknown>): McpToolResult => {
              const denied = outOfTeam(planTask)
              if (denied) return denied
              const r = writeTaskDocument(db, {
                taskId: planTask,
                agentId: boundAgentId ?? '',
                body: str(args['body']),
                executionId: boundExecutionId ?? null,
              })
              if (!r.ok)
                return textResult(WRITE_PLAN_REFUSAL[r.reason] ?? `write failed: ${r.reason}`, true)
              // Who wrote it and on which run, from the binding. Never its words: the log is
              // read more widely than the row. A plan moves nothing, so `to` is where the task
              // still is, as for a report.
              const written = r.unchanged ? null : getTask(db, planTask)
              if (written)
                recordWrite('status_changed', written, {
                  to: written.status,
                  reason: 'plan_written',
                  revision: r.revision,
                })
              return textResult(
                r.unchanged
                  ? `The plan is unchanged: revision ${r.revision} already says this.`
                  : `Saved as revision ${r.revision} of this task's plan.`,
              )
            },
          },
        ]
      : []),
    {
      name: 'unblock_task',
      description: 'Unblock a task (back to todo).',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        const denied = outOfTeam(str(args['taskId']))
        if (denied) return denied
        const r = unblockTask(db, str(args['taskId']), { unlessPersonMoved: true })
        recordStatus(r, 'todo')
        return statusWriteResult(r, 'unblock')
      },
    },
    {
      name: 'add_comment',
      description: `Add a comment to a task (report-up summaries, system notes).${ownTaskHint('comment on')}`,
      inputSchema: z.object({
        taskId: taskIdField,
        body: z.string(),
        authorAgentId: z.string().optional(),
        authorType: z.enum(['agent', 'user', 'system']).optional(),
      }),
      handler: (args) => {
        const taskId = taskOf(args)
        const denied = outOfTeam(taskId)
        if (denied) return denied
        // An unverified caller cannot prove it is the author it names, so the
        // comment posts as a plain agent comment rather than under someone else's
        // name OR under someone else's KIND.
        //
        // Both halves are needed and the first version of this guard only had one.
        // Dropping `authorAgentId` while still honouring `authorType` left the
        // more useful forgery intact: the task drawer renders the type verbatim as
        // the comment's attribution, so `authorType: 'user'` displays as
        // "user: <body>" to the operator and is handed to peer agents by
        // `get_task`. Choosing 'user' also drops the comment out of the drawer's
        // Report section, which filters on 'agent' — so the same argument both
        // forges an authority and hides the forgery from the place a human looks.
        // The field also triggers an action: over REST, a 'user' comment is
        // delivered into the assignee's live run as the person steering it, which
        // is why that route honours 'user' only from the dashboard's own page.
        // This tool writes the row directly and delivers nothing, so here the
        // attack is the label, and the label is aimed squarely at the human.
        //
        // A session bound to an agent always comments as that agent. The ticket
        // block shows a later run who wrote each comment ("person", "clawboo" or
        // the agent's name), so an agent naming another author or kind would be
        // speaking as the person or the engine to whoever runs the task next.
        const unverified = opts?.unverifiedCaller === true
        const asSelf = unverified || boundAgentId !== undefined
        const comment = addComment(
          db,
          taskId,
          str(args['body']),
          asSelf
            ? 'agent'
            : ((optStr(args['authorType']) as 'agent' | 'user' | 'system' | undefined) ?? 'agent'),
          unverified ? undefined : (boundAgentId ?? optStr(args['authorAgentId'])),
          // Written through a Tasks session bound to its agent. Only that may ever count
          // as the agent's own words, so only that may wake a teammate.
          {
            ...(boundAgentId !== undefined && !unverified ? { kind: 'agent' as const } : {}),
            executionId: boundExecutionId ?? null,
          },
        )
        recordWrite('comment_added', getTask(db, taskId), {
          authorType: comment.authorType,
          body: comment.body,
        })
        const wake = agentCommentWakeNote(saveAgentCommentWake(db, taskId, comment))
        return jsonResult({ ...comment, ...(wake ? { wake } : {}) })
      },
    },
    {
      name: 'link_task',
      description:
        'Make taskId depend on dependsOnTaskId (it stays unready until the dependency is done).',
      inputSchema: z.object({ taskId: z.string(), dependsOnTaskId: z.string() }),
      handler: (args) => {
        // BOTH ends: linking across the boundary would leak the existence of an
        // out-of-team task through the dependency graph even if neither id is
        // otherwise readable.
        const denied = outOfTeam(str(args['taskId'])) ?? outOfTeam(str(args['dependsOnTaskId']))
        if (denied) return denied
        try {
          linkDep(db, str(args['taskId']), str(args['dependsOnTaskId']))
        } catch (error) {
          if (error instanceof TaskDependencyCycleError) {
            return textResult(error.message, true)
          }
          throw error
        }
        recordWrite('dep_linked', getTask(db, str(args['taskId'])), {
          dependsOnTaskId: str(args['dependsOnTaskId']),
        })
        return textResult(
          `linked: ${str(args['taskId'])} depends on ${str(args['dependsOnTaskId'])}`,
        )
      },
    },
  ]

  /**
   * A readable id in an argument becomes the task's id before the tool sees it, so
   * every tool takes both and no tool can miss it. A reference that does not resolve
   * reaches the tool as it came, which answers "not found" in the caller's own words.
   * A bound session resolves only its own team's ids, so it cannot learn what another
   * team's readable id points at.
   */
  const acceptReadableIds = (tool: ToolDef): ToolDef => ({
    ...tool,
    handler: (args) => {
      const resolved: Record<string, unknown> = { ...args }
      for (const name of TASK_REF_ARGS) {
        const ref = args[name]
        if (typeof ref !== 'string' || !isTaskIdentifier(ref)) continue
        const id = resolveTaskRef(db, ref, boundTeamId ? { teamId: boundTeamId } : {})
        if (id) resolved[name] = id
      }
      return tool.handler(resolved)
    },
  })

  const withheld = new Set<string>()
  if (teamRun) for (const name of TEAM_RUN_WITHHELD_TOOL_NAMES) withheld.add(name)
  if (opts?.unverifiedCaller === true)
    for (const name of [...IDENTITY_TOOL_NAMES, ...STATUS_TOOL_NAMES, 'write_plan'])
      withheld.add(name)
  const active = (
    opts?.readOnly === true
      ? tools.filter(
          (t) =>
            READ_ONLY_TOOL_NAMES.has(t.name) ||
            (ASK_TOOL_NAMES.has(t.name) && !withheld.has(t.name)),
        )
      : tools.filter((t) => !withheld.has(t.name))
  ).map(acceptReadableIds)
  // Mid-run inbox piggyback for a bound calling agent (see ../piggyback.ts).
  return buildServer(
    'clawboo-tasks',
    boundAgentId ? withInboxPiggyback(active, db, boundAgentId, { teamId: boundTeamId }) : active,
  )
}
