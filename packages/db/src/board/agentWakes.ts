// ─── Helpers waking each other: what a person said, and the brakes ──────────
// A person is asked once per job whether its agents may wake each other, by a card in
// Needs you the first time one would. After that they may, within brakes. One row per
// job holds the decision, the card and this hour's count (`agent_wake_gates`), and one
// per pair of agents in a team holds a back-and-forth (`agent_wake_chains`), so a restart
// or an evicted engine resets none of it. The rules themselves are @clawboo/board-core's;
// the wake pump decides when to ask (see apps/web's taskWakes), because only it knows a
// wake would really start the task.
//
// The card is not a `task_questions` row. A question blocks its task and ends with any
// move of it. This blocks nothing and is about the job, and it stands only while a wake
// is really waiting on it (`cardStands`), so it can never outlive what it asks about.
// There is one at a time in a team: the answer covers every task waiting behind it, so a
// lead's fan-out of top-level tasks gets one ask.

import {
  afterAgentWakeChain,
  afterAgentWakeHour,
  agentWakeVerdict,
  AGENT_WAKE_WINDOW_MS,
  commentMayWake,
  delegationTargetOf,
  isTerminal,
  parseWaitingOn,
  teammateMayEndWait,
  waitsOnOtherWork,
  type AgentWakeCard,
  type AgentWakeCardKind,
  type AgentWakeChoice,
  type AgentWakeVerdict,
  type TaskStatus,
} from '@clawboo/board-core'
import { and, eq, inArray, isNull, isNotNull, ne } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { getSetting, setSetting } from '../db'
import { appendEvent } from '../events/appendEvent'
import { enqueueInbox } from '../inbox'
import { personJson, type PersonRecord } from '../person'
import {
  agentWakeGates,
  taskComments,
  tasks,
  taskWakes,
  type DbAgentWakeGate,
  type DbTask,
  type DbTaskComment,
  type DbTaskWake,
} from '../schema'
import {
  listWaitingTaskWakes,
  recordTaskWakeTx,
  settleTaskWakes,
  wakeCommentIds,
} from '../taskWakes'
import {
  chainOfPair,
  dropChainOfPairTx,
  gateOfJob,
  jobTaskIdOf,
  NO_CARD,
  writeChainOfPairTx,
} from './agentWakeState'
import { immediateWrite, type BoardTx } from './contention'
import { emitBoardLifecycle } from './events'
import { readTaskRunnerInputs } from './runnerInputs'

export { jobTaskIdOf }

/** The team's "always allow", beside its work check. */
export function teamAgentWakesSettingKey(teamId: string): string {
  return `team-agent-wakes:${teamId}`
}

export function readTeamAlwaysAllow(db: ClawbooDb, teamId: string | null | undefined): boolean {
  if (!teamId) return false
  const raw = getSetting(db, teamAgentWakesSettingKey(teamId))
  if (!raw) return false
  try {
    return (JSON.parse(raw) as { always?: unknown }).always === true
  } catch {
    return false
  }
}

export function setTeamAlwaysAllow(db: ClawbooDb, teamId: string, always: boolean): void {
  setSetting(db, teamAgentWakesSettingKey(teamId), JSON.stringify({ always }))
}

/** The job's row, from any task in it. */
export function readAgentWakeGate(db: ClawbooDb, taskId: string): DbAgentWakeGate | null {
  return gateOfJob(db, jobTaskIdOf(db, taskId))
}

export interface AgentWakePair {
  fromAgentId: string | null
  toAgentId: string | null
}

/** May this wake go now, from the job's row, the pair's and the team's setting? */
export function agentWakeVerdictFor(
  db: ClawbooDb,
  taskId: string,
  pair: AgentWakePair,
  now = Date.now(),
): AgentWakeVerdict {
  const teamId =
    db.select({ teamId: tasks.teamId }).from(tasks).where(eq(tasks.id, taskId)).get()?.teamId ??
    null
  return agentWakeVerdict(readAgentWakeGate(db, taskId), {
    ...pair,
    teamAlways: readTeamAlwaysAllow(db, teamId),
    chain:
      pair.fromAgentId && pair.toAgentId
        ? chainOfPair(db, teamId, pair.fromAgentId, pair.toAgentId)
        : null,
    now,
  })
}

/** Who wrote the last comment this wake carries: the agent doing the waking. */
export function agentWakeFromOf(db: ClawbooDb, row: Pick<DbTaskWake, 'commentIds'>): string | null {
  const last = wakeCommentIds(row).at(-1)
  if (!last) return null
  return (
    db
      .select({ author: taskComments.authorAgentId })
      .from(taskComments)
      .where(eq(taskComments.id, last))
      .get()?.author ?? null
  )
}

function agentOfTask(task: DbTask): string | null {
  return (
    task.assigneeAgentId ??
    delegationTargetOf(task.sourceDelegationId) ??
    readTaskRunnerInputs(task)?.assigneeAgentId ??
    null
  )
}

export type AgentCommentWake =
  /** Nothing to wake: no one else's agent, or the task has no turn to give. */
  | { state: 'none' }
  /** A person said no for this job. The comment stays on the thread. */
  | { state: 'declined'; agentId: string }
  /** Saved. The pump decides what it does, and asks a person if it comes to that. */
  | { state: 'saved'; agentId: string }

/** How much of a comment a mailbox note carries. A digest cuts what follows. */
const MAILBOX_COMMENT_CHARS = 1_000

/**
 * An agent commented on a task, through a Tasks session bound to it. Save a wake for
 * the task's agent, unless it would wake no one. The comment is on the thread whatever
 * this says, and a bound session is the only writer of this kind: a REST comment's
 * author is whatever its caller sent.
 *
 * A wait on other work ends when that work does, so a comment there wakes nothing. A run
 * on the task runner has no ticket block, so its comment also goes in the mailbox whatever
 * happens next, which is what it reads. That is not a wake: a yes or a no decides whether
 * one starts.
 */
export function saveAgentCommentWake(
  db: ClawbooDb,
  taskId: string,
  comment: Pick<DbTaskComment, 'id' | 'kind' | 'authorAgentId' | 'body'>,
): AgentCommentWake {
  if (comment.kind !== 'agent') return { state: 'none' }
  const out = immediateWrite(
    db,
    (tx): { result: AgentCommentWake; teamId: string | null } | null => {
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
      if (!task || task.dropped || isTerminal(task.status as TaskStatus)) return null
      const agentId = agentOfTask(task)
      if (!agentId || agentId === comment.authorAgentId) return null
      const now = Date.now()
      const teamId = task.teamId ?? null
      if (task.runnerInputs) {
        const cut = comment.body.length > MAILBOX_COMMENT_CHARS
        enqueueInbox(db, {
          agentId,
          teamId,
          kind: 'task_update',
          taskId,
          body: `A teammate commented on your task "${task.title}": ${
            cut
              ? `${comment.body.slice(0, MAILBOX_COMMENT_CHARS)}\n… (cut: the whole comment is on the task)`
              : comment.body
          }`,
        })
      }
      // A person's task is their turn, and a card in Backlog was parked on purpose.
      if (task.assigneePersonId || task.status === 'backlog') return null
      if (waitsOnOtherWork(parseWaitingOn(task.waitingOn))) return null
      const denied = gateOfJob(tx, jobTaskIdOf(tx, taskId))?.decision === 'deny'
      if (!commentMayWake(comment, { agentWakes: !denied }))
        return { result: { state: 'declined', agentId }, teamId }
      recordTaskWakeTx(
        tx,
        { teamId, agentId, taskId, reason: 'agent_comment', commentIds: [comment.id] },
        now,
      )
      return { result: { state: 'saved', agentId }, teamId }
    },
  )
  if (!out) return { state: 'none' }
  if (out.result.state === 'saved')
    emitBoardLifecycle({
      kind: 'task_wake_recorded',
      taskId,
      teamId: out.teamId,
      reason: 'agent_comment',
    })
  return out.result
}

/** Make sure the job has its row, and hand back its key. */
function ensureGateTx(tx: BoardTx, task: DbTask, now: number): string {
  const jobTaskId = jobTaskIdOf(tx, task.id)
  tx.insert(agentWakeGates)
    .values({ jobTaskId, teamId: task.teamId ?? null, updatedAt: now })
    .onConflictDoNothing()
    .run()
  return jobTaskId
}

/** Its task still waits on what its agent said it needs, so a teammate's comment could end
 *  that. A question, a hand-back, a failure or a move ended anything a card could ask. */
const waitsOnWhatItsAgentNeeds = (task: DbTask): boolean =>
  !task.dropped &&
  task.status === 'blocked' &&
  !task.assigneePersonId &&
  teammateMayEndWait(parseWaitingOn(task.waitingOn))

/** A wake really is waiting on this card: its task can still be started by one, and the
 *  wake is not yet taken by a run or held by a Stop. Anything else, and nothing is asking. */
function cardStands(tx: ClawbooDb | BoardTx, gate: DbAgentWakeGate, now: number): boolean {
  if (!gate.cardKind || !gate.cardTaskId) return false
  if (
    gate.cardKind === 'hourly_cap' &&
    (gate.windowStartedAt === null || now - gate.windowStartedAt >= AGENT_WAKE_WINDOW_MS)
  )
    return false
  const task = tx.select().from(tasks).where(eq(tasks.id, gate.cardTaskId)).get() as
    DbTask | undefined
  if (!task || !waitsOnWhatItsAgentNeeds(task)) return false
  return (
    tx
      .select({ id: taskWakes.id })
      .from(taskWakes)
      .where(
        and(
          eq(taskWakes.taskId, task.id),
          eq(taskWakes.reason, 'agent_comment'),
          isNull(taskWakes.settledAt),
          isNull(taskWakes.carriedExecId),
          isNull(taskWakes.heldAt),
        ),
      )
      .get() !== undefined
  )
}

/** The other tasks told they wait for this answer. A task that moved on since is not. */
function waitingBehindCard(tx: ClawbooDb | BoardTx, gate: DbAgentWakeGate): DbTaskWake[] {
  const rows = tx
    .select({ wake: taskWakes, task: tasks })
    .from(taskWakes)
    .innerJoin(tasks, eq(tasks.id, taskWakes.taskId))
    .where(
      and(
        eq(taskWakes.reason, 'agent_comment'),
        eq(taskWakes.skipReason, 'ask_once'),
        isNull(taskWakes.settledAt),
        isNull(taskWakes.carriedExecId),
        isNull(taskWakes.heldAt),
        ne(taskWakes.taskId, gate.cardTaskId ?? ''),
        gate.teamId ? eq(taskWakes.teamId, gate.teamId) : isNull(taskWakes.teamId),
      ),
    )
    .all()
    .filter((r) => waitsOnWhatItsAgentNeeds(r.task as DbTask))
    .map((r) => r.wake as DbTaskWake)
  // A task with no team shares its card only with its own job.
  return gate.teamId ? rows : rows.filter((r) => jobTaskIdOf(tx, r.taskId) === gate.jobTaskId)
}

/**
 * Put the card up on this task. One at a time in a team: while another stands, this wake
 * waits behind it, and the answer covers both. A card nothing is waiting on any more does
 * not count. Says whether it changed anything, and tells whoever is looking when it did:
 * the task's status has not moved, so nothing else would.
 */
export function openAgentWakeCard(
  db: ClawbooDb,
  input: AgentWakePair & { taskId: string; kind: AgentWakeCardKind },
): boolean {
  const now = Date.now()
  const opened = immediateWrite(db, (tx): DbTask | null => {
    const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get() as
      DbTask | undefined
    if (!task) return null
    const jobTaskId = ensureGateTx(tx, task, now)
    const others = tx
      .select()
      .from(agentWakeGates)
      .where(
        and(
          isNotNull(agentWakeGates.cardKind),
          task.teamId
            ? eq(agentWakeGates.teamId, task.teamId)
            : eq(agentWakeGates.jobTaskId, jobTaskId),
        ),
      )
      .all() as DbAgentWakeGate[]
    for (const other of others) {
      if (other.cardTaskId === task.id) {
        if (other.cardKind === input.kind) return null
        continue
      }
      if (cardStands(tx, other, now)) return null
    }
    tx.update(agentWakeGates)
      .set({
        cardKind: input.kind,
        cardTaskId: task.id,
        cardFromAgentId: input.fromAgentId,
        cardToAgentId: input.toAgentId,
        cardAt: now,
        updatedAt: now,
      })
      .where(eq(agentWakeGates.jobTaskId, jobTaskId))
      .run()
    return task
  })
  if (!opened) return false
  announceCard(db, opened, input.kind)
  return true
}

/** Open boards read it from this, and browser alerts from the event log. */
function announceCard(db: ClawbooDb, task: DbTask, kind: AgentWakeCardKind | null): void {
  emitBoardLifecycle({
    kind: 'status_changed',
    taskId: task.id,
    teamId: task.teamId ?? null,
    status: task.status,
  })
  try {
    appendEvent(db, {
      kind: 'status_changed',
      taskId: task.id,
      teamId: task.teamId,
      data: { to: task.status, reason: kind ? `agent_wakes_${kind}` : 'agent_wakes_answered' },
    })
  } catch {
    // Best-effort: the card stands, and the board shows it at its next read.
  }
}

export type DecideAgentWakesResult =
  | {
      ok: true
      jobTaskId: string
      /** Every job the answer decided: this one, and those waiting behind its card. */
      jobTaskIds: string[]
      cardTaskId: string | null
      choice: AgentWakeChoice
    }
  | { ok: false; reason: 'no_card' | 'no_team' }

/**
 * What a person pressed on the card. Yes (on the job, or in the team) also starts the
 * hour again and lets the card's two agents carry on, which is what lifts a pause. An ask
 * answers for every task waiting behind it. No closes every agent's wake on those jobs; a
 * person's stays. A card nothing is waiting on answers nothing, so a second press or a
 * stale page changes nothing.
 */
export function decideAgentWakes(
  db: ClawbooDb,
  taskId: string,
  choice: AgentWakeChoice,
  person: PersonRecord,
): DecideAgentWakesResult {
  const now = Date.now()
  const result = immediateWrite(db, (tx): DecideAgentWakesResult => {
    const jobTaskId = jobTaskIdOf(tx, taskId)
    const gate = gateOfJob(tx, jobTaskId)
    if (!gate || !cardStands(tx, gate, now)) return { ok: false, reason: 'no_card' }
    if (choice === 'team' && !gate.teamId) return { ok: false, reason: 'no_team' }
    const behind =
      gate.cardKind === 'ask'
        ? waitingBehindCard(tx, gate).map((row) => jobTaskIdOf(tx, row.taskId))
        : []
    const jobTaskIds = [...new Set([jobTaskId, ...behind])]
    const decided = {
      decision: choice === 'no' ? 'deny' : 'allow',
      decidedBy: personJson(person),
      decidedAt: now,
      updatedAt: now,
    }
    for (const job of jobTaskIds)
      tx.insert(agentWakeGates)
        .values({ jobTaskId: job, teamId: gate.teamId, ...decided })
        .onConflictDoUpdate({ target: agentWakeGates.jobTaskId, set: decided })
        .run()
    tx.update(agentWakeGates)
      .set({ ...NO_CARD, windowStartedAt: null, windowCount: 0, updatedAt: now })
      .where(eq(agentWakeGates.jobTaskId, jobTaskId))
      .run()
    if (gate.cardFromAgentId && gate.cardToAgentId)
      dropChainOfPairTx(tx, gate.teamId, gate.cardFromAgentId, gate.cardToAgentId)
    if (choice === 'team') setTeamAlwaysAllow(db, gate.teamId as string, true)
    return { ok: true, jobTaskId, jobTaskIds, cardTaskId: gate.cardTaskId, choice }
  })
  if (!result.ok) return result
  if (choice === 'no') for (const job of result.jobTaskIds) settleDeclinedAgentWakes(db, job)
  const shown = result.cardTaskId
    ? (db.select().from(tasks).where(eq(tasks.id, result.cardTaskId)).get() as DbTask | undefined)
    : undefined
  if (shown) announceCard(db, shown, null)
  return result
}

/** The waiting wakes on this job that came from an agent's comment. */
export function agentCommentWakesOfJob(db: ClawbooDb, jobTaskId: string): DbTaskWake[] {
  return listWaitingTaskWakes(db, { includeHeld: true }).filter(
    (row) => row.reason === 'agent_comment' && jobTaskIdOf(db, row.taskId) === jobTaskId,
  )
}

/** A person said no: nothing on this job is waiting for that answer any more. */
export function settleDeclinedAgentWakes(db: ClawbooDb, jobTaskId: string): void {
  settleTaskWakes(
    db,
    agentCommentWakesOfJob(db, jobTaskId).map((row) => row.id),
    'declined',
  )
}

/**
 * An agent's comment really started a run: count it, for the job's hour and for the pair.
 * Written with the move that starts it, so the count is on disk before anything can run.
 * A wake that goes means nothing is waiting on the person any more, so a card still up (a
 * cap whose hour ended, an ask the team's always made moot) comes down.
 */
export function noteAgentWakeStarted(
  db: ClawbooDb,
  taskId: string,
  pair: AgentWakePair,
  now = Date.now(),
): void {
  immediateWrite(db, (tx) => {
    const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as DbTask | undefined
    if (!task) return
    const jobTaskId = ensureGateTx(tx, task, now)
    tx.update(agentWakeGates)
      .set({ ...afterAgentWakeHour(gateOfJob(tx, jobTaskId), now), ...NO_CARD, updatedAt: now })
      .where(eq(agentWakeGates.jobTaskId, jobTaskId))
      .run()
    if (pair.fromAgentId && pair.toAgentId)
      writeChainOfPairTx(
        tx,
        task.teamId,
        pair.fromAgentId,
        pair.toAgentId,
        afterAgentWakeChain(
          chainOfPair(tx, task.teamId, pair.fromAgentId, pair.toAgentId),
          pair.fromAgentId,
          now,
        ),
      )
  })
}

/**
 * The card each of these tasks shows, keyed by task id: only one a wake is really waiting
 * on (`cardStands`). One that lost its wake leaves the task to read as what it is.
 */
export function agentWakeCardsForTasks(
  db: ClawbooDb,
  rows: readonly Pick<DbTask, 'id' | 'status'>[],
  now = Date.now(),
): Map<string, AgentWakeCard> {
  const out = new Map<string, AgentWakeCard>()
  const blocked = rows.filter((t) => t.status === 'blocked').map((t) => t.id)
  if (blocked.length === 0) return out
  const gates = db
    .select()
    .from(agentWakeGates)
    .where(inArray(agentWakeGates.cardTaskId, blocked))
    .all() as DbAgentWakeGate[]
  for (const gate of gates) {
    if (!gate.cardTaskId || !cardStands(db, gate, now)) continue
    const alsoWaiting = gate.cardKind === 'ask' ? waitingBehindCard(db, gate).length : 0
    out.set(gate.cardTaskId, {
      jobTaskId: gate.jobTaskId,
      kind: gate.cardKind as AgentWakeCardKind,
      fromAgentId: gate.cardFromAgentId,
      toAgentId: gate.cardToAgentId,
      ...(alsoWaiting > 0 ? { alsoWaiting } : {}),
    })
  }
  return out
}
