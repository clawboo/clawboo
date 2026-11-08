// Plan documents, and plans that wait for a person.
//
// A plan is a document on a task (`task_documents`, key `plan`): every revision is its
// own row, so a new one never costs an old one. On a team that asks first (a per-team
// switch, off at first), a plan's steps become a "suggest tasks" question, and the
// question's acceptance is what creates them.
//
// The plan waits on the run's own task when it can, as any question does. A turn with
// no task of its own (a lead's chat turn, a follow-up on a finished task), and a routine's
// task, which never waits for a person, put it on a card of its own instead: a task whose
// whole job is to hold the plan. One waits per agent and room, so a lead that re-issues a
// plan never stacks up a second question.
//
// Accepting runs inside the answer's own write (`answerQuestion`), so the question, the
// revision's decision, the steps and their chain all land or none do. Every guard reads
// inside that write.

import { randomUUID } from 'node:crypto'

import {
  acceptedPlanSteps,
  canTransition,
  answerWords,
  encodePlanHolder,
  HAND_OFF_TITLE_CHARS,
  isPlanHolder,
  isTerminal,
  parseQuestionPayload,
  planStepsMatch,
  QUESTION_ANSWER_MAX_CHARS,
  renderPlanBody,
  TASK_DOCUMENT_MAX_CHARS,
  TASK_DOCUMENT_MAX_REVISIONS,
  TASK_DOCUMENT_PLAN_KEY,
  waitingOnJson,
  type PlanAskReason,
  type PlanRef,
  type QuestionAnswer,
  type QuestionPayload,
  type SuggestedTask,
  type TaskStatus,
} from '@clawboo/board-core'
import {
  checkDepthCap,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PLAN_STEPS,
} from '@clawboo/governance'
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm'

import { getSetting, type ClawbooDb } from '../db'
import { appendEvent } from '../events/appendEvent'
import { personJson, type PersonRecord } from '../person'
import {
  reportUpOutbox,
  taskDocuments,
  taskQuestions,
  tasks,
  type DbTask,
  type DbTaskDocument,
  type DbTaskQuestion,
} from '../schema'
import { immediateWrite, type BoardTx } from './contention'
import { roomForAcceptedStepsTx } from './jobRuns'
import {
  deriveCreateKey,
  existingTaskForCreate,
  SAME_TASK_WINDOW_MS,
  taskOfCreateKey,
} from './createDedupe'
import { emitBoardLifecycle } from './events'
import { commentMarkTx, expirePendingQuestionsTx } from './questionExpiry'
import {
  addComment,
  completeExecutionProcess,
  countChildSlots,
  createExecutionProcess,
  firedByRoutine,
  insertMainTaskTx,
  insertTask,
  linkDep,
  personMovedSinceLastRun,
  TaskDependencyCycleError,
  updateStatus,
  type MainTaskRequest,
} from './repository'

// ─── The switch ──────────────────────────────────────────────────────────────

export function planApprovalSettingKey(teamId: string): string {
  return `team-plan-approval:${teamId}`
}

/** Does this team ask a person before a plan starts? Off unless a person turned it on. */
export function planApprovalOn(db: ClawbooDb, teamId: string | null | undefined): boolean {
  if (!teamId) return false
  const raw = getSetting(db, planApprovalSettingKey(teamId))
  if (!raw) return false
  try {
    return (JSON.parse(raw) as { on?: unknown }).on === true
  } catch {
    return false
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

export type WriteDocumentResult =
  | { ok: true; revision: number; unchanged?: true }
  | {
      ok: false
      reason: 'not_found' | 'not_yours' | 'finished' | 'empty' | 'too_long' | 'too_many_revisions'
    }

function newestRevisionTx(tx: BoardTx, taskId: string, key: string): DbTaskDocument | undefined {
  return tx
    .select()
    .from(taskDocuments)
    .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
    .orderBy(desc(taskDocuments.revision))
    .limit(1)
    .get() as DbTaskDocument | undefined
}

/** A new revision, numbered after `newest`. */
function insertRevisionTx(
  tx: BoardTx,
  task: Pick<DbTask, 'id' | 'teamId'>,
  key: string,
  body: string,
  agentId: string,
  executionId: string | null,
  newest: DbTaskDocument | undefined,
  now: number,
): DbTaskDocument {
  const row: DbTaskDocument = {
    id: randomUUID(),
    taskId: task.id,
    teamId: task.teamId ?? null,
    key,
    revision: (newest?.revision ?? 0) + 1,
    body,
    authorAgentId: agentId,
    executionId,
    questionId: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: now,
  }
  tx.insert(taskDocuments).values(row).run()
  return row
}

/** Write a task's document as the agent working on it. A body the same as the newest
 *  is not a new revision, so a retried call writes nothing. */
export function writeTaskDocument(
  db: ClawbooDb,
  input: {
    taskId: string
    agentId: string
    body: string
    key?: string
    /** The run writing it, when an agent's run is. */
    executionId?: string | null
  },
): WriteDocumentResult {
  const key = input.key ?? TASK_DOCUMENT_PLAN_KEY
  if (!input.body.trim()) return { ok: false, reason: 'empty' }
  if (input.body.length > TASK_DOCUMENT_MAX_CHARS) return { ok: false, reason: 'too_long' }
  return immediateWrite(db, (tx): WriteDocumentResult => {
    const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get() as
      DbTask | undefined
    if (!task || task.dropped) return { ok: false, reason: 'not_found' }
    if (isTerminal(task.status as TaskStatus)) return { ok: false, reason: 'finished' }
    if (task.assigneeAgentId !== input.agentId) return { ok: false, reason: 'not_yours' }
    const newest = newestRevisionTx(tx, task.id, key)
    if (newest?.body === input.body) return { ok: true, revision: newest.revision, unchanged: true }
    if ((newest?.revision ?? 0) >= TASK_DOCUMENT_MAX_REVISIONS)
      return { ok: false, reason: 'too_many_revisions' }
    const row = insertRevisionTx(
      tx,
      task,
      key,
      input.body,
      input.agentId,
      input.executionId ?? null,
      newest,
      Date.now(),
    )
    return { ok: true, revision: row.revision }
  })
}

/** A task's document: the newest revision, or the one named. */
export function getTaskDocument(
  db: ClawbooDb,
  taskId: string,
  key: string = TASK_DOCUMENT_PLAN_KEY,
  revision?: number,
): DbTaskDocument | null {
  const row = db
    .select()
    .from(taskDocuments)
    .where(
      and(
        eq(taskDocuments.taskId, taskId),
        eq(taskDocuments.key, key),
        ...(revision !== undefined ? [eq(taskDocuments.revision, revision)] : []),
      ),
    )
    .orderBy(desc(taskDocuments.revision))
    .limit(1)
    .get() as DbTaskDocument | undefined
  return row ?? null
}

export type TaskDocumentRevision = Omit<DbTaskDocument, 'body'> & { chars: number }

/** A task's revisions of a document, newest first, without their bodies. */
export function listTaskDocumentRevisions(
  db: ClawbooDb,
  taskId: string,
  key: string = TASK_DOCUMENT_PLAN_KEY,
): TaskDocumentRevision[] {
  return db
    .select({
      id: taskDocuments.id,
      taskId: taskDocuments.taskId,
      teamId: taskDocuments.teamId,
      key: taskDocuments.key,
      revision: taskDocuments.revision,
      authorAgentId: taskDocuments.authorAgentId,
      executionId: taskDocuments.executionId,
      questionId: taskDocuments.questionId,
      decision: taskDocuments.decision,
      decidedBy: taskDocuments.decidedBy,
      decidedAt: taskDocuments.decidedAt,
      createdAt: taskDocuments.createdAt,
      chars: sql<number>`length(${taskDocuments.body})`,
    })
    .from(taskDocuments)
    .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.key, key)))
    .orderBy(desc(taskDocuments.revision))
    .all() as TaskDocumentRevision[]
}

// ─── Proposing ───────────────────────────────────────────────────────────────

export interface ProposePlanInput {
  teamId: string
  /** The agent proposing it: the one its answer goes back to. */
  agentId: string
  /** What the person reads above the steps. */
  prompt: string
  steps: SuggestedTask[]
  /** The run's own task, when it has one. */
  taskId: string | null
  /** Where the steps go when the plan has a card of its own. */
  parentTaskId: string | null
  roomId?: string | null
  /** The turn it came from: a replay of that turn finds its card. */
  turnId?: string | null
  /** May it wait on a card of its own? No for a tool call, which is about its own task. */
  holderAllowed?: boolean
  /** A batch of hand-offs rather than an ordered plan: accepted, its steps start at once. */
  parallel?: boolean
  /** The run proposing it, when it has one: a lead's chat turn does not. Its words go on
   *  the thread under this run once the plan is answered. */
  executionId?: string | null
  /** The person's message this answers, when no task holds it yet: its main task lands
   *  with the card, and the card and the accepted steps file under it. */
  mainTask?: MainTaskRequest
  /** The one-to-one chat it came from: its card shows there, and the answer and the
   *  accepted steps' results go back there. */
  chatSessionKey?: string | null
  /** Put to the person whatever the team's switch says (see `PlanAskReason`). The card is
   *  its own: it takes no other's place, and none takes its place. */
  ask?: PlanAskReason
}

export type ProposeRefusal =
  | 'no_steps'
  | 'too_many_steps'
  | 'step_too_long'
  | 'too_deep'
  | 'too_many_revisions'
  | 'not_found'
  | 'not_yours'
  | 'finished'
  | 'person_moved'
  | 'routine'
  | 'illegal_transition'
  | 'root_rate_cap'
  | 'main_closed'

export type ProposePlanResult =
  /** This team's plans start at once. Nothing was written. */
  | { status: 'off' }
  | {
      status: 'proposed'
      task: DbTask
      question: DbTaskQuestion
      revision: number
      /** The plan got a card of its own just now. */
      holderCreated: boolean
      /** The person's message got its main task just now. */
      mainTask?: DbTask
      /** The plan that was waiting, which this one took the place of. */
      replaced?: { title: string; revision: number }
    }
  /** These same steps wait for a person already. */
  | { status: 'waiting'; taskId: string; questionId: string }
  /** A person already answered these same steps. `replay`: this very turn, seen again. */
  | { status: 'already_accepted' | 'already_declined'; taskId: string; replay?: true }
  /** The turn's card was closed by a person, and a replay does not bring it back. */
  | { status: 'closed'; taskId: string }
  | { status: 'refused'; reason: ProposeRefusal; task?: DbTask }

/** The newest plan question on a task, with what it proposed. */
function latestPlanQuestionTx(
  tx: BoardTx,
  taskId: string,
): { row: DbTaskQuestion; payload: QuestionPayload } | null {
  const rows = tx
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.kind, 'suggest_tasks')))
    // Two in one millisecond are still in order: the newer one was inserted later.
    .orderBy(desc(taskQuestions.createdAt), desc(sql`rowid`))
    .all() as DbTaskQuestion[]
  for (const row of rows) {
    const payload = parseQuestionPayload(row.payload)
    if (payload?.plan) return { row, payload }
  }
  return null
}

/** The card already holding this agent's waiting plan in this room, if any. One from a
 *  one-to-one chat and one from the team's chat are two plans: each answer goes back to
 *  where it was asked, so neither takes the other's place. */
function waitingHolderTx(
  tx: BoardTx | ClawbooDb,
  input: { teamId: string; agentId: string; chatSessionKey?: string | null },
  roomId: string | null,
): DbTask | null {
  const rows = tx
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.teamId, input.teamId),
        eq(taskQuestions.agentId, input.agentId),
        eq(taskQuestions.kind, 'suggest_tasks'),
        eq(taskQuestions.status, 'pending'),
      ),
    )
    .all() as DbTaskQuestion[]
  for (const row of rows) {
    const plan = parseQuestionPayload(row.payload)?.plan
    // A card asked whatever the switch says is a request of its own: no plan takes its
    // place, and the switch going off does not close it.
    if (!plan?.holder || plan.ask) continue
    const task = tx.select().from(tasks).where(eq(tasks.id, row.taskId)).get() as DbTask | undefined
    if (
      task &&
      (task.roomId ?? null) === roomId &&
      (task.chatSessionKey ?? null) === (input.chatSessionKey ?? null)
    )
      return task
  }
  return null
}

/** A plan on a card of its own that this agent had answered lately in this room and this
 *  chat, with these steps as it proposed them or as the person left them. A later turn saying the
 *  same thing is a repeat: it must not bring a new card, or a second run of finished work. */
function answeredHolderPlanTx(
  tx: BoardTx,
  input: {
    teamId: string
    agentId: string
    chatSessionKey?: string | null
    steps: readonly SuggestedTask[]
  },
  roomId: string | null,
  now: number,
): { taskId: string; accepted: boolean } | null {
  const rows = tx
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.teamId, input.teamId),
        eq(taskQuestions.agentId, input.agentId),
        eq(taskQuestions.kind, 'suggest_tasks'),
        eq(taskQuestions.status, 'answered'),
        gt(taskQuestions.answeredAt, now - SAME_TASK_WINDOW_MS),
      ),
    )
    .orderBy(desc(taskQuestions.answeredAt), desc(sql`rowid`))
    .all() as DbTaskQuestion[]
  for (const row of rows) {
    const payload = parseQuestionPayload(row.payload)
    if (!payload?.plan?.holder) continue
    const answer = JSON.parse(row.answer ?? '{}') as { accepted?: boolean; tasks?: SuggestedTask[] }
    if (
      !planStepsMatch(payload.tasks ?? [], input.steps) &&
      !planStepsMatch(answer.tasks ?? [], input.steps)
    )
      continue
    const task = tx.select().from(tasks).where(eq(tasks.id, row.taskId)).get() as DbTask | undefined
    if (
      (task?.roomId ?? null) === roomId &&
      (task?.chatSessionKey ?? null) === (input.chatSessionKey ?? null)
    )
      return { taskId: row.taskId, accepted: answer.accepted === true }
  }
  return null
}

/**
 * A plan is starting without asking, because the team's switch went off. The plan this
 * agent had waiting on a card of its own is out of date, and accepting it now would run
 * the same work a second time, so the new one takes its place.
 */
export function closeWaitingHolderWhenOff(
  db: ClawbooDb,
  input: Pick<
    ProposePlanInput,
    'teamId' | 'agentId' | 'taskId' | 'parentTaskId' | 'roomId' | 'chatSessionKey'
  >,
): void {
  const scopeOf = (read: BoardTx | ClawbooDb): string | null => {
    const from = input.taskId ?? input.parentTaskId
    const row = from
      ? (read.select({ roomId: tasks.roomId }).from(tasks).where(eq(tasks.id, from)).get() as
          { roomId: string | null } | undefined)
      : undefined
    return input.roomId ?? row?.roomId ?? null
  }
  // A read first: a team that never asked takes no write lock for this.
  if (!waitingHolderTx(db, input, scopeOf(db))) return
  const closed = immediateWrite(db, (tx): string | null => {
    const holder = waitingHolderTx(tx, input, scopeOf(tx))
    if (!holder) return null
    expirePendingQuestionsTx(tx, holder.id, 'replaced', Date.now())
    updateStatus(db, holder.id, 'cancelled')
    addComment(
      db,
      holder.id,
      'This plan was closed: this team no longer asks first, and its agent started a plan without asking. Nothing from this one started.',
      'system',
      null,
      { kind: 'note' },
    )
    return holder.id
  })
  if (!closed) return
  try {
    appendEvent(db, {
      kind: 'status_changed',
      taskId: closed,
      teamId: input.teamId,
      agentId: input.agentId,
      data: { to: 'cancelled', reason: 'plan_replaced' },
    })
  } catch {
    // Best effort, as for an ask.
  }
}

/** The title of the plan this agent has waiting on a card of its own, for its next turn. */
export function waitingPlanTitle(
  db: ClawbooDb,
  input: { teamId: string; agentId: string },
  roomId: string | null,
): string | null {
  return waitingHolderTx(db, input, roomId)?.title ?? null
}

/** How deep a parent sits for the depth cap, as `createSubtaskTx` counts it: its
 *  ancestors, less a person's main task, which is not a level. */
function parentDepthTx(tx: BoardTx, parentTaskId: string): number {
  let depth = 0
  let cursor: string | null =
    tx
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, parentTaskId))
      .get()?.parentTaskId ?? null
  for (
    let steps = 0;
    cursor !== null && depth < DEFAULT_MAX_DEPTH && steps <= DEFAULT_MAX_DEPTH + 1;
    steps++
  ) {
    const row: { parentTaskId: string | null; isMainTask: number } | undefined = tx
      .select({ parentTaskId: tasks.parentTaskId, isMainTask: tasks.isMainTask })
      .from(tasks)
      .where(eq(tasks.id, cursor))
      .get()
    if (row?.isMainTask !== 1) depth += 1
    cursor = row?.parentTaskId ?? null
  }
  return depth
}

const stepTooLong = (step: SuggestedTask): boolean =>
  step.title.length > QUESTION_ANSWER_MAX_CHARS ||
  (step.description?.length ?? 0) > QUESTION_ANSWER_MAX_CHARS

/** The brief of a card holding a plan. An answer closes the card without a run, so its
 *  agent reads this only if a person moves the card back to To do. */
const HOLDER_BRIEF =
  'This task held a plan you proposed, and a person moved it back to you. Its comments say what became of the plan. If it was accepted, its tasks are on the board: do not hand them out again. Say where things stand, and ask before you propose it again.'

function holderTitle(steps: readonly SuggestedTask[]): string {
  const more = steps.length > 1 ? ` and ${steps.length - 1} more` : ''
  const room = HAND_OFF_TITLE_CHARS - 'Plan: '.length - more.length
  return `Plan: ${steps[0]!.title.slice(0, room)}${more}`
}

/** Why a run's own task cannot wait for a person on this plan, or null when it can. */
function ownTaskRefusalTx(
  tx: BoardTx,
  own: DbTask | undefined,
  agentId: string,
): ProposeRefusal | null {
  if (!own || own.dropped) return 'not_found'
  if (isTerminal(own.status as TaskStatus)) return 'finished'
  if (own.assigneeAgentId !== agentId) return 'not_yours'
  // A routine's person may be away, and it files a new task on its next run.
  if (firedByRoutine(own)) return 'routine'
  if (personMovedSinceLastRun(tx, own)) return 'person_moved'
  if (!canTransition(own.status as TaskStatus, 'blocked')) return 'illegal_transition'
  return null
}

/**
 * Put a plan in front of a person, if this team asks first, or whatever it says when the
 * input has an `ask` reason. `off` means the caller starts the plan as it always did, and
 * the only thing written is the close of a plan of this agent's still waiting from when
 * the switch was on. The plan's steps exist only on the question until a person accepts it.
 */
export function proposePlan(db: ClawbooDb, input: ProposePlanInput): ProposePlanResult {
  if (!input.ask && !planApprovalOn(db, input.teamId)) {
    closeWaitingHolderWhenOff(db, input)
    return { status: 'off' }
  }
  const { steps } = input
  if (steps.length === 0) return { status: 'refused', reason: 'no_steps' }
  // Whole, before anything exists: a plan cut short is worse than none.
  if (steps.length > DEFAULT_MAX_PLAN_STEPS) return { status: 'refused', reason: 'too_many_steps' }
  if (steps.some(stepTooLong)) return { status: 'refused', reason: 'step_too_long' }

  const result = immediateWrite(db, (tx): ProposePlanResult => {
    const now = Date.now()
    const own = input.taskId
      ? (tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get() as DbTask | undefined)
      : undefined
    const ownRefusal = input.taskId ? ownTaskRefusalTx(tx, own, input.agentId) : 'not_found'
    const onOwnTask = ownRefusal === null
    if (!onOwnTask && input.holderAllowed === false)
      return { status: 'refused', reason: ownRefusal, ...(own ? { task: own } : {}) }

    // A card that only holds a plan runs only if a person moved it back. Its plan is still
    // a holder's: the steps do not go under it, and an answer closes it.
    const ownIsHolder = onOwnTask && isPlanHolder(own!.sourceDelegationId)
    let parentTaskId = !onOwnTask ? input.parentTaskId : ownIsHolder ? own!.parentTaskId : own!.id
    const parent =
      !onOwnTask && parentTaskId
        ? (tx.select().from(tasks).where(eq(tasks.id, parentTaskId)).get() as DbTask | undefined)
        : undefined
    const roomId = input.roomId ?? own?.roomId ?? parent?.roomId ?? null

    // A named key, not a derived one: it must still find the card while it is Blocked.
    const holderKey = input.turnId
      ? {
          key: deriveCreateKey(
            ['plan-home', input.teamId, input.turnId, input.agentId],
            renderPlanBody(steps),
          ).key,
        }
      : null
    // A card asked whatever the switch says takes no other's place.
    const waitingHolder = onOwnTask || input.ask ? null : waitingHolderTx(tx, input, roomId)
    const turnsHolder =
      onOwnTask || waitingHolder || !holderKey
        ? null
        : existingTaskForCreate(tx, { title: '', createKey: holderKey }, now)
    const home = onOwnTask ? own! : (waitingHolder ?? turnsHolder)
    const last = home ? latestPlanQuestionTx(tx, home.id) : null

    if (home) {
      if (last && planStepsMatch(last.payload.tasks ?? [], steps)) {
        if (last.row.status === 'pending')
          return { status: 'waiting', taskId: home.id, questionId: last.row.id }
        if (last.row.status === 'answered') {
          const answer = JSON.parse(last.row.answer ?? '{}') as { accepted?: boolean }
          return {
            status: answer.accepted ? 'already_accepted' : 'already_declined',
            taskId: home.id,
            ...(turnsHolder ? { replay: true as const } : {}),
          }
        }
      }
      if (!onOwnTask && isTerminal(home.status as TaskStatus))
        return { status: 'closed', taskId: home.id }
    }

    // A routine's next fire is a new request. A chat turn saying what was already decided
    // is not, and the agent must hear so rather than get a new card.
    if (!onOwnTask && !(own && firedByRoutine(own))) {
      const answered = answeredHolderPlanTx(tx, { ...input, steps }, roomId, now)
      if (answered)
        return {
          status: answered.accepted ? 'already_accepted' : 'already_declined',
          taskId: answered.taskId,
        }
    }

    // A person's message with no task yet: the card and its main task land in this one
    // write, so a plan that goes nowhere leaves no empty card. A plan taking the place of
    // one already waiting stays where that one is, under its main task.
    const request = !onOwnTask && !parentTaskId ? input.mainTask : undefined
    const heldMain = request && !home ? taskOfCreateKey(tx, { key: request.key }, now) : null
    if (heldMain && (heldMain.dropped === 1 || isTerminal(heldMain.status as TaskStatus)))
      return { status: 'refused', reason: 'main_closed', task: heldMain }
    if (request && home) parentTaskId = home.parentTaskId
    else if (heldMain) parentTaskId = heldMain.id

    if (
      parentTaskId &&
      !checkDepthCap({ depth: parentDepthTx(tx, parentTaskId), max: DEFAULT_MAX_DEPTH }).ok
    )
      return { status: 'refused', reason: 'too_deep', ...(own ? { task: own } : {}) }

    let mainTask: DbTask | undefined
    if (request && !home && !heldMain) {
      const made = insertMainTaskTx(tx, request, { teamId: input.teamId, roomId }, {}, now)
      if (!made.ok) return { status: 'refused', reason: 'root_rate_cap' }
      mainTask = made.mainTask
      parentTaskId = mainTask.id
    }

    const holderCreated = !home
    const task =
      home ??
      insertTask(tx, {
        title: holderTitle(steps),
        description: HOLDER_BRIEF,
        teamId: input.teamId,
        roomId,
        parentTaskId,
        assigneeRuntime: 'openclaw',
        status: 'blocked',
        // An answer closes it, and the agent that proposed the plan hears that in its
        // own session. No agent waits on this card, and it does no work to report.
        sourceDelegationId: encodePlanHolder(input.agentId, randomUUID()),
        createKey: holderKey,
        chatSessionKey: input.chatSessionKey ?? null,
      })

    const newest = newestRevisionTx(tx, task.id, TASK_DOCUMENT_PLAN_KEY)
    // A document the agent wrote and nobody was asked about yet is what this asks about.
    // A plan asked about again, whose earlier question closed unanswered, keeps its revision.
    const body = renderPlanBody(steps)
    const reuse =
      newest &&
      newest.decision === null &&
      ((newest.questionId === null && newest.authorAgentId === input.agentId) ||
        newest.body === body)
    if (!reuse && (newest?.revision ?? 0) >= TASK_DOCUMENT_MAX_REVISIONS)
      return { status: 'refused', reason: 'too_many_revisions', task }
    const revision = reuse
      ? newest
      : insertRevisionTx(
          tx,
          task,
          TASK_DOCUMENT_PLAN_KEY,
          body,
          input.agentId,
          input.executionId ?? null,
          newest,
          now,
        )

    // A plan re-issued while another waits takes its place, so there is never a second. The
    // person is told on the card, and the caller tells the chat.
    const replacing = last?.row.status === 'pending' ? last : null
    expirePendingQuestionsTx(tx, task.id, 'replaced', now)
    const holder = !onOwnTask || ownIsHolder
    const plan: PlanRef = {
      revision: revision.revision,
      parentTaskId,
      holder,
      ...(input.parallel ? { parallel: true } : {}),
      ...(input.ask ? { ask: input.ask } : {}),
    }
    const replacedRevision = replacing?.payload.plan?.revision ?? 0
    const payload: QuestionPayload = {
      prompt: replacing
        ? `${input.prompt} It takes the place of the plan that was waiting, which stays readable as revision ${replacedRevision}.`
        : input.prompt,
      tasks: steps,
      plan,
    }
    const question: DbTaskQuestion = {
      id: randomUUID(),
      taskId: task.id,
      teamId: task.teamId ?? null,
      agentId: input.agentId,
      kind: 'suggest_tasks',
      payload: JSON.stringify(payload),
      status: 'pending',
      idempotencyKey: null,
      executionId: input.executionId ?? null,
      commentMark: commentMarkTx(tx, task.id),
      answer: null,
      answeredBy: null,
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      answeredAt: null,
    }
    tx.insert(taskQuestions).values(question).run()
    tx.update(taskDocuments)
      .set({ questionId: question.id })
      .where(eq(taskDocuments.id, revision.id))
      .run()
    tx.update(tasks)
      .set({
        status: 'blocked',
        assigneeAgentId: input.agentId,
        waitingOn: waitingOnJson({ kind: 'question', questionId: question.id }),
        // A card's title is its plan, so it changes with it. A task's own title is not.
        ...(holder ? { title: holderTitle(steps) } : {}),
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id))
      .run()
    if (replacing)
      addComment(
        db,
        task.id,
        `A newer plan took the place of ${holder ? `"${task.title}"` : 'the plan that was waiting'}. Nothing from that one started, and it stays readable as revision ${replacedRevision}.`,
        'system',
        null,
        { kind: 'note' },
      )
    return {
      status: 'proposed',
      task: tx.select().from(tasks).where(eq(tasks.id, task.id)).get() as DbTask,
      question,
      revision: revision.revision,
      holderCreated,
      ...(mainTask ? { mainTask } : {}),
      ...(replacing ? { replaced: { title: task.title, revision: replacedRevision } } : {}),
    }
  })

  if (result.status === 'proposed') {
    const { task, question, holderCreated, mainTask } = result
    if (mainTask)
      emitBoardLifecycle({
        kind: 'task_created',
        taskId: mainTask.id,
        teamId: mainTask.teamId ?? null,
        status: mainTask.status,
        sourceDelegationId: null,
      })
    if (holderCreated)
      emitBoardLifecycle({
        kind: 'task_created',
        taskId: task.id,
        teamId: task.teamId ?? null,
        status: task.status,
        sourceDelegationId: task.sourceDelegationId ?? null,
      })
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId: task.id,
      teamId: task.teamId ?? null,
      status: 'blocked',
    })
    // The event log is what browser alerts follow, and this write can come from any
    // process. Never the plan's words: the log is read more widely than the row.
    try {
      appendEvent(db, {
        kind: 'status_changed',
        taskId: task.id,
        teamId: task.teamId ?? null,
        agentId: input.agentId,
        data: {
          to: 'blocked',
          reason: 'question',
          questionId: question.id,
          plan: true,
          actor: { kind: 'agent', agentId: input.agentId, execId: input.executionId ?? null },
        },
      })
    } catch {
      // The plan waits either way; the run's end announces it too.
    }
  }
  return result
}

// ─── Answering ───────────────────────────────────────────────────────────────

export type PlanAcceptRefusal =
  | { reason: 'answered' }
  | { reason: 'too_many_steps'; max: number }
  | { reason: 'too_deep'; max: number }
  | { reason: 'no_room'; room: number; max: number }

export interface PlanSettled {
  /** The steps this answer made. */
  created: DbTask[]
  /** Steps a task already open stood in for: each holds its place in the chain. */
  linked: DbTask[]
}

/** Why an answer cannot be taken as it stands, read before anything is written, so a
 *  refusal changes nothing and the person can answer again. */
export function planAnswerRefusalTx(
  tx: BoardTx,
  task: DbTask,
  plan: PlanRef,
  answer: Extract<QuestionAnswer, { kind: 'suggest_tasks' }>,
): PlanAcceptRefusal | null {
  const revision = tx
    .select()
    .from(taskDocuments)
    .where(
      and(
        eq(taskDocuments.taskId, task.id),
        eq(taskDocuments.key, TASK_DOCUMENT_PLAN_KEY),
        eq(taskDocuments.revision, plan.revision),
      ),
    )
    .get() as DbTaskDocument | undefined
  if (revision?.decision) return { reason: 'answered' }
  if (!answer.accepted) return null
  if (answer.tasks.length > DEFAULT_MAX_PLAN_STEPS)
    return { reason: 'too_many_steps', max: DEFAULT_MAX_PLAN_STEPS }
  if (plan.parentTaskId) {
    if (!checkDepthCap({ depth: parentDepthTx(tx, plan.parentTaskId), max: DEFAULT_MAX_DEPTH }).ok)
      return { reason: 'too_deep', max: DEFAULT_MAX_DEPTH }
    // The card holding the plan takes a slot of its own, and its job ends with this answer.
    const held = plan.holder && task.parentTaskId === plan.parentTaskId ? 1 : 0
    const room = Math.max(0, DEFAULT_MAX_CHILDREN - countChildSlots(tx, plan.parentTaskId) + held)
    if (answer.tasks.length > room) return { reason: 'no_room', room, max: DEFAULT_MAX_CHILDREN }
  }
  return null
}

/**
 * Inside the answer's own write: record the decision on the revision, and on an
 * acceptance create the steps and chain them, each waiting on the one before. A step
 * goes through the same repeat checks as a hand-off, so an open task with the same words
 * stands in for it. The guarded write on the decision means a revision is accepted once.
 */
export function settlePlanAnswerTx(
  db: ClawbooDb,
  tx: BoardTx,
  ctx: {
    question: DbTaskQuestion
    task: DbTask
    plan: PlanRef
    proposed: readonly SuggestedTask[]
    answer: Extract<QuestionAnswer, { kind: 'suggest_tasks' }>
    person: PersonRecord
    now: number
  },
): PlanSettled {
  const { question, task, plan, answer, person, now } = ctx
  const decided = tx
    .update(taskDocuments)
    .set({
      decision: answer.accepted ? 'accepted' : 'declined',
      decidedBy: personJson(person),
      decidedAt: now,
    })
    .where(
      and(
        eq(taskDocuments.taskId, task.id),
        eq(taskDocuments.key, TASK_DOCUMENT_PLAN_KEY),
        eq(taskDocuments.revision, plan.revision),
        isNull(taskDocuments.decision),
      ),
    )
    .run().changes
  const settled: PlanSettled = { created: [], linked: [] }
  if (decided === 0) return settled

  const proposer = question.agentId ?? ''
  let previous: string | null = null
  const steps = answer.accepted ? acceptedPlanSteps(ctx.proposed, answer.tasks, proposer) : []
  steps.forEach((step, index) => {
    const row = {
      title: step.title.slice(0, HAND_OFF_TITLE_CHARS),
      ...(step.description ? { description: step.description } : {}),
      teamId: task.teamId,
      roomId: task.roomId,
      parentTaskId: plan.parentTaskId,
      assigneeRuntime: 'openclaw',
      // What the pump fires it on after a restart, and who hears its result.
      sourceDelegationId: `${question.id}:plan:${index}:agent:${step.agentId}:reflectTo:${proposer}`,
      requestedBy: person,
      // A plan from a one-to-one chat: its steps' results go back there.
      chatSessionKey: task.chatSessionKey,
      agentCreated: true,
      titleMatchNeedsOwner: true,
      titleMatchExceptTurn: question.id,
      createKey: deriveCreateKey(
        ['plan-accept', task.id, String(plan.revision), String(index)],
        step.description ?? step.title,
      ),
    }
    const found = existingTaskForCreate(tx, row, now)
    const made = found ?? insertTask(tx, row)
    if (found) settled.linked.push(made)
    else settled.created.push(made)
    if (!plan.parallel && previous && previous !== made.id) {
      try {
        linkDep(db, made.id, previous)
      } catch (err) {
        // Only an open task standing in for a step can close a loop. It keeps its own
        // place, and the plan carries on after it.
        if (!(err instanceof TaskDependencyCycleError)) throw err
      }
    }
    previous = made.id
  })
  if (plan.parentTaskId && settled.created.length > 0)
    roomForAcceptedStepsTx(tx, plan.parentTaskId, settled.created.length, now)
  // Last in the write: the steps exist by the time anything hears the card closed.
  if (plan.holder) closeAnsweredHolderTx(db, tx, { question, task, answer, now })
  return settled
}

/**
 * Inside the answer's own write: close a card that only held a plan, and tell the agent
 * that proposed it through the durable `[Task Update]` outbox. So it hears in the session
 * that proposed the plan, a restart loses nothing, and nothing runs on a card that has no
 * work: a run here would land on the card alone, in a session of its own.
 */
function closeAnsweredHolderTx(
  db: ClawbooDb,
  tx: BoardTx,
  ctx: {
    question: DbTaskQuestion
    task: DbTask
    answer: Extract<QuestionAnswer, { kind: 'suggest_tasks' }>
    now: number
  },
): void {
  const { question, task, answer, now } = ctx
  if (answer.accepted) {
    // Done is reached through In progress: nothing moves Blocked straight to Done.
    updateStatus(db, task.id, 'in_progress')
    updateStatus(db, task.id, 'done')
  } else {
    updateStatus(db, task.id, 'cancelled', { actor: 'person' })
  }
  if (!task.teamId) return
  const agentId = question.agentId
  tx.insert(reportUpOutbox)
    .values({
      id: randomUUID(),
      teamId: task.teamId,
      roomId: task.roomId ?? null,
      recipientAgentId: agentId,
      taskId: task.id,
      // The engine's `ReportUp`, as its outbox stores one.
      payload: JSON.stringify({
        toAgentId: agentId,
        by: 'A person',
        title: task.title,
        summary: answerWords(answer, { planCreated: true }),
        outcome: answer.accepted ? 'plan_accepted' : 'plan_declined',
        taskId: task.id,
      }),
      replays: 0,
      createdAt: now,
      settledAt: null,
      settledHow: null,
      heldAt: null,
      // A plan from a one-to-one chat: that chat hears the answer, in a turn of its own.
      chatSessionKey: task.chatSessionKey,
    })
    .run()
}

// ─── A Stop ──────────────────────────────────────────────────────────────────

const STOPPED_NOTE =
  'A person pressed Stop while this plan waited for an answer, so it was closed. Nothing was started.'

/**
 * A Stop closes the plans waiting in this team (and room, when named): the person halted
 * the team, so nothing is left that a later press would start without a fresh ask. A card
 * holding only the plan is cancelled. A task with work of its own goes back to To do as a
 * stopped task, with the cancelled run the pump reads as a Stop, and its Retry plans again.
 * The revisions stay readable. An ordinary question is not a plan and is left alone.
 */
export function closeWaitingPlans(
  db: ClawbooDb,
  scope: { teamId: string; roomId?: string | null },
): string[] {
  const closed = immediateWrite(db, (tx): Array<{ taskId: string; holder: boolean }> => {
    const now = Date.now()
    const rows = tx
      .select()
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.teamId, scope.teamId),
          eq(taskQuestions.kind, 'suggest_tasks'),
          eq(taskQuestions.status, 'pending'),
        ),
      )
      .all() as DbTaskQuestion[]
    const out: Array<{ taskId: string; holder: boolean }> = []
    for (const row of rows) {
      const plan = parseQuestionPayload(row.payload)?.plan
      if (!plan) continue
      const task = tx.select().from(tasks).where(eq(tasks.id, row.taskId)).get() as
        DbTask | undefined
      if (!task) continue
      if (scope.roomId !== undefined && (task.roomId ?? null) !== scope.roomId) continue
      expirePendingQuestionsTx(tx, row.taskId, 'stopped', now)
      const moved = updateStatus(db, row.taskId, plan.holder ? 'cancelled' : 'todo', {
        actor: 'person',
      })
      if (!moved.ok) {
        // The question is gone, so the task must not go on saying it waits for it.
        tx.update(tasks)
          .set({ waitingOn: null, updatedAt: now })
          .where(eq(tasks.id, row.taskId))
          .run()
        continue
      }
      if (!plan.holder) {
        const exec = createExecutionProcess(db, {
          taskId: row.taskId,
          executorType: 'openclaw',
          engineRun: true,
        })
        completeExecutionProcess(db, exec.id, { status: 'cancelled', byPerson: true })
      }
      addComment(db, row.taskId, STOPPED_NOTE, 'system', null, { kind: 'note' })
      out.push({ taskId: row.taskId, holder: plan.holder })
    }
    return out
  })
  for (const { taskId, holder } of closed) {
    // What the alerts wake on: this one no longer needs anyone.
    try {
      appendEvent(db, {
        kind: 'status_changed',
        taskId,
        teamId: scope.teamId,
        data: { to: holder ? 'cancelled' : 'todo', reason: 'plan_stopped' },
      })
    } catch {
      // Best effort, as for an ask.
    }
  }
  return closed.map((c) => c.taskId)
}
