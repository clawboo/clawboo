// ─── Tasks MCP server ────────────────────────────────────────────────────────
// A thin protocol façade over the durable board repository (@clawboo/db). Lets
// ANY runtime coordinate on the same board. Atomic claim surfaces a conflict as
// a tool-error the model must NOT retry (the "never retry a 409" rule).

import {
  addComment,
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
  handOffChain,
  isTaskIdentifier,
  isTeamLeadAgent,
  linkDep,
  listTasks,
  releaseTask,
  resolveTaskRef,
  setTaskDelegator,
  TaskDependencyCycleError,
  taskStatusSchema,
  unblockTask,
  updateStatus,
  type ClawbooDb,
  type CreatedTask,
  type CreateTaskInput,
  type DbTask,
  type GuardedCreateResult,
  type TaskStatus,
  type UpdateStatusResult,
} from '@clawboo/db'
import { z } from 'zod'

import { withInboxPiggyback } from '../piggyback'
import {
  buildServer,
  jsonResult,
  textResult,
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
  return textResult(`${verb} failed: ${r.reason}`, true)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
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
const TASK_REF_ARGS = ['taskId', 'parentTaskId', 'dependsOnTaskId'] as const

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

/** The board's read surface: the half that is safe to attach to an agent that
 *  must not mutate the board at all (a Clawboo Native team run). */
const READ_ONLY_TOOL_NAMES = new Set(['list_tasks', 'get_task'])
/** Tools whose ARGUMENTS name an agent, so an unidentified caller acts as anyone. */
const IDENTITY_TOOL_NAMES = new Set(['claim_task', 'assign_task'])
/** Tools that move a card: who may call them depends on who is calling. */
const STATUS_TOOL_NAMES = new Set([
  'release_task',
  'update_task_status',
  'block_task',
  'unblock_task',
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
   */
  boundScope?: { teamId?: string | null; agentId?: string | null; taskId?: string | null }

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

  const claimFor = (args: Record<string, unknown>, assigneeAgentId: string): McpToolResult => {
    const denied = outOfTeam(str(args['taskId']))
    if (denied) return denied
    const result = claimTask(
      db,
      str(args['taskId']),
      assigneeAgentId,
      optStr(args['assigneeRuntime']),
    )
    if (!result.ok) return textResult(`claim failed: ${result.reason}`, true) // conflict → DO NOT retry
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
        return jsonResult({ task, comments: getComments(db, id), ancestors: getAncestors(db, id) })
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
      }),
      handler: (args) => {
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
        releaseTask(db, str(args['taskId']))
        return textResult(`released: ${str(args['taskId'])}`)
      },
    },
    {
      name: 'update_task_status',
      description:
        'Transition a task status (state-machine enforced; illegal transitions error). Cancelling a task also cancels the plan steps still waiting on it.',
      inputSchema: z.object({ taskId: z.string(), status: STATUS }),
      handler: (args) => {
        const taskId = str(args['taskId'])
        const denied = outOfTeam(taskId)
        if (denied) return denied
        const status = str(args['status']) as TaskStatus
        const r = updateStatus(db, taskId, status, { unlessPersonMoved: true })
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
        ? `Mark the task you are working on blocked, when you cannot go on without a person. Say why in your reply.${boundTaskId ? ' Leave out taskId to block it.' : ''}`
        : `Mark a task blocked.${boundTaskId ? ' Leave out taskId to block the task you are working on, when you cannot go on without a person, and say why in your reply.' : ''}`,
      inputSchema: z.object({ taskId: taskIdField }),
      handler: (args) => {
        const taskId = taskOf(args)
        const denied = outOfTeam(taskId)
        if (denied) return denied
        if (teamRun && getTask(db, taskId)?.assigneeAgentId !== boundAgentId)
          return textResult(
            'On a team run, block_task blocks only the task you are working on. To raise a problem with another task, use add_comment on it.',
            true,
          )
        const r = blockTask(db, taskId, { unlessPersonMoved: true })
        return statusWriteResult(r, 'block')
      },
    },
    {
      name: 'unblock_task',
      description: 'Unblock a task (back to todo).',
      inputSchema: z.object({ taskId: z.string() }),
      handler: (args) => {
        const denied = outOfTeam(str(args['taskId']))
        if (denied) return denied
        const r = unblockTask(db, str(args['taskId']), { unlessPersonMoved: true })
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
        return jsonResult(
          addComment(
            db,
            taskId,
            str(args['body']),
            asSelf
              ? 'agent'
              : ((optStr(args['authorType']) as 'agent' | 'user' | 'system' | undefined) ??
                  'agent'),
            unverified ? undefined : (boundAgentId ?? optStr(args['authorAgentId'])),
          ),
        )
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
    for (const name of [...IDENTITY_TOOL_NAMES, ...STATUS_TOOL_NAMES]) withheld.add(name)
  const active = (
    opts?.readOnly === true
      ? tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name))
      : tools.filter((t) => !withheld.has(t.name))
  ).map(acceptReadableIds)
  // Mid-run inbox piggyback for a bound calling agent (see ../piggyback.ts).
  return buildServer(
    'clawboo-tasks',
    boundAgentId ? withInboxPiggyback(active, db, boundAgentId, { teamId: boundTeamId }) : active,
  )
}
