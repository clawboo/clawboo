// task_questions accessors: an agent asks a person, and the person answers.
//
// An ask blocks the task with `waiting_on` set to the question, in one write. The
// tool cannot end the run, but the engine's self-block ending does: a task still
// mapped and Blocked at the run's end closes as an agent's block.
//
// An answer is judged inside its own write transaction, against the row and the
// task as they are then. As an approval's answer does (`resolveApproval`), every
// write is guarded on `status = 'pending'`, so an answer and an expiry never both
// land. The answer clears the reason and leaves the task Blocked: the wake moves it,
// so a crash between the two leaves it to a person rather than losing it.

import { randomUUID } from 'node:crypto'

import {
  canTransition,
  isTerminal,
  normalizeAnswer,
  parseQuestionPayload,
  parseWaitingOn,
  waitingOnJson,
  type QuestionKind,
  type QuestionPayload,
  type TaskStatus,
} from '@clawboo/board-core'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { appendEvent } from '../events/appendEvent'
import { personJson, type PersonRecord } from '../person'
import { taskQuestions, tasks, type DbTask, type DbTaskQuestion } from '../schema'
import { immediateWrite } from './contention'
import { emitBoardLifecycle } from './events'
import { expirePendingQuestionsTx } from './questionExpiry'
import { firedByRoutine, personMovedSinceLastRun } from './repository'

export interface AskQuestionInput {
  taskId: string
  /** The agent asking: it must be the one on the task. */
  agentId: string
  kind: QuestionKind
  payload: QuestionPayload
  /** A repeated call with this key asks once. */
  idempotencyKey?: string | null
}

export type AskQuestionResult =
  | { ok: true; question: DbTaskQuestion; task: DbTask; existing?: boolean }
  | {
      ok: false
      reason:
        'not_found' | 'not_yours' | 'finished' | 'person_moved' | 'illegal_transition' | 'routine'
      task?: DbTask
    }

export function askQuestion(db: ClawbooDb, input: AskQuestionInput): AskQuestionResult {
  const key = input.idempotencyKey || null
  const result = immediateWrite(db, (tx): AskQuestionResult => {
    const row = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get() as
      DbTask | undefined
    if (!row || row.dropped) return { ok: false, reason: 'not_found' }
    const from = row.status as TaskStatus
    if (isTerminal(from)) return { ok: false, reason: 'finished', task: row }
    if (row.assigneeAgentId !== input.agentId) return { ok: false, reason: 'not_yours', task: row }
    // A routine's person may be away, and it files a new task on its next run.
    if (firedByRoutine(row)) return { ok: false, reason: 'routine', task: row }
    if (personMovedSinceLastRun(tx, row)) return { ok: false, reason: 'person_moved', task: row }
    // A repeat of a question still open or answered. One that closed unanswered freed
    // its key, so it is asked again and the task really waits.
    if (key) {
      const earlier = tx
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, row.id), eq(taskQuestions.idempotencyKey, key)))
        .get() as DbTaskQuestion | undefined
      if (earlier) return { ok: true, question: earlier, task: row, existing: true }
    }
    if (!canTransition(from, 'blocked')) return { ok: false, reason: 'illegal_transition' }
    const now = Date.now()
    expirePendingQuestionsTx(tx, row.id, 'replaced', now)
    const question: DbTaskQuestion = {
      id: randomUUID(),
      taskId: row.id,
      teamId: row.teamId ?? null,
      agentId: input.agentId,
      kind: input.kind,
      payload: JSON.stringify(input.payload),
      status: 'pending',
      idempotencyKey: key,
      answer: null,
      answeredBy: null,
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      answeredAt: null,
    }
    tx.insert(taskQuestions).values(question).run()
    tx.update(tasks)
      .set({
        status: 'blocked',
        waitingOn: waitingOnJson({ kind: 'question', questionId: question.id }),
        updatedAt: now,
      })
      .where(eq(tasks.id, row.id))
      .run()
    const task = tx.select().from(tasks).where(eq(tasks.id, row.id)).get() as DbTask
    return { ok: true, question, task }
  })
  if (result.ok && !result.existing) {
    emitBoardLifecycle({
      kind: 'status_changed',
      taskId: result.task.id,
      teamId: result.task.teamId ?? null,
      status: 'blocked',
    })
    // The event log is what browser alerts follow, and this write can come from any
    // process. Never the question's text: the log is read more widely than the row.
    try {
      appendEvent(db, {
        kind: 'status_changed',
        taskId: result.task.id,
        teamId: result.task.teamId ?? null,
        agentId: input.agentId,
        data: { to: 'blocked', reason: 'question', questionId: result.question.id },
      })
    } catch {
      // The question stands; the run's end announces it too.
    }
  }
  return result
}

export type AnswerQuestionResult =
  | { ok: true; question: DbTaskQuestion; task: DbTask }
  | {
      ok: false
      reason: 'not_found' | 'invalid_answer' | 'answered' | 'expired' | 'cancelled'
    }

/** Record a person's answer. `person` is who the route says answered: the verified
 *  person, or the built-in local one. Never taken from the request body. */
export function answerQuestion(
  db: ClawbooDb,
  questionId: string,
  rawAnswer: unknown,
  opts: { person: PersonRecord },
): AnswerQuestionResult {
  return immediateWrite(db, (tx): AnswerQuestionResult => {
    const q = tx.select().from(taskQuestions).where(eq(taskQuestions.id, questionId)).get() as
      DbTaskQuestion | undefined
    if (!q) return { ok: false, reason: 'not_found' }
    if (q.status !== 'pending')
      return { ok: false, reason: q.status === 'answered' ? 'answered' : (q.status as 'expired') }
    // The clock is read once the write lock is held, as for an approval.
    const now = Date.now()
    const task = tx.select().from(tasks).where(eq(tasks.id, q.taskId)).get() as DbTask | undefined
    if (!task || task.dropped || isTerminal(task.status as TaskStatus)) {
      expirePendingQuestionsTx(tx, q.taskId, 'task_closed', now)
      return { ok: false, reason: 'expired' }
    }
    const payload = parseQuestionPayload(q.payload)
    const answer = payload ? normalizeAnswer(q.kind, payload, rawAnswer) : null
    if (!answer) return { ok: false, reason: 'invalid_answer' }
    const changed = tx
      .update(taskQuestions)
      .set({
        status: 'answered',
        answer: JSON.stringify(answer),
        answeredBy: personJson(opts.person),
        answeredAt: now,
        updatedAt: now,
      })
      .where(and(eq(taskQuestions.id, q.id), eq(taskQuestions.status, 'pending')))
      .run().changes
    if (changed === 0) return { ok: false, reason: 'expired' }
    const waiting = parseWaitingOn(task.waitingOn)
    if (waiting?.kind === 'question' && waiting.questionId === q.id) {
      tx.update(tasks).set({ waitingOn: null, updatedAt: now }).where(eq(tasks.id, task.id)).run()
    }
    return {
      ok: true,
      question: tx
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.id, q.id))
        .get() as DbTaskQuestion,
      task: tx.select().from(tasks).where(eq(tasks.id, task.id)).get() as DbTask,
    }
  })
}

/** One question. */
export function getQuestion(db: ClawbooDb, questionId: string): DbTaskQuestion | null {
  return (
    (db.select().from(taskQuestions).where(eq(taskQuestions.id, questionId)).get() as
      DbTaskQuestion | undefined) ?? null
  )
}

/** A task's questions, oldest first. */
export function listTaskQuestions(db: ClawbooDb, taskId: string): DbTaskQuestion[] {
  return db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.taskId, taskId))
    .orderBy(asc(taskQuestions.createdAt))
    .all() as DbTaskQuestion[]
}

/** The question each of these tasks has open, keyed by task id. One read per board. */
export function pendingQuestionsForTasks(
  db: ClawbooDb,
  taskIds: readonly string[],
): Map<string, DbTaskQuestion> {
  const out = new Map<string, DbTaskQuestion>()
  if (taskIds.length === 0) return out
  const rows = db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.status, 'pending'), inArray(taskQuestions.taskId, [...taskIds])))
    .orderBy(asc(taskQuestions.createdAt))
    .all() as DbTaskQuestion[]
  for (const q of rows) out.set(q.taskId, q)
  return out
}
