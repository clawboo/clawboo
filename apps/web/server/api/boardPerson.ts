// ─── A person's own writes on the board ─────────────────────────────────────
// Reopen, assign to a person, answer a question. Each is a person-only route: under
// /api/ (so the access gate and the origin guard apply) and never under /api/mcp/,
// where a runtime's attach token gets in without the cookie. Each refuses a request
// the dashboard's page did not send (`isDashboardRequest`), and records the verified
// person, or the install's built-in one, as who did it. Behind a sign-in proxy in
// `required` mode every request here needs a verified person anyway. Locally it stays
// the speed bump that check is: see lib/dashboardRequest.

import type { Request, Response } from 'express'

import {
  addComment,
  answerForAgent,
  answerQuestion,
  answerWords,
  askedWords,
  answerQuestionBody,
  assignPersonBody,
  assignTaskToPerson,
  attentionForTask,
  getQuestion,
  getTask,
  listExecutions,
  listTaskQuestions,
  noteBlockedReason,
  parsePersonJson,
  parseQuestionPayload,
  reopenTask,
  reopenTaskBody,
  runOwnWrite,
  type ClawbooDb,
  type QuestionAnswer,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { actingPerson, personField } from '../lib/auth'
import { ownWriterOf } from '../lib/boardReader'
import { getDb } from '../lib/db'
import { isDashboardRequest } from '../lib/dashboardRequest'
import { engineHeld } from '../lib/engineHold'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { emitEvent } from '../lib/obs'
import { runnerTargetOf } from '../lib/runnerRoute'
import { startTask } from '../lib/startBoardTask'
import { noteHumanMove } from '../lib/teamChat/humanMove'
import type { ReplyDelivery } from '../lib/teamChat/personReply'
import {
  savePersonWake,
  startPersonWake,
  type SavedPersonWake,
  type SavePersonWakeDeps,
} from '../lib/teamChat/personWake'
import { engineRefusal } from '../lib/teamChat/roomRoster'
import type { TaskWakePumpDeps } from '../lib/teamChat/taskWakes'
import { clearTaskSessionPointers } from '../lib/teamChat/taskSessionPointers'

const log = createLogger('board-person')

function refuseUnlessDashboard(req: Request, res: Response): boolean {
  if (isDashboardRequest(req)) return false
  res.status(403).json({ ok: false, error: 'dashboard_only' })
  return true
}

/** What saving a person's wake needs: as Retry, team chat could not run a task its
 *  engine cannot see. */
function saveDeps(db: ClawbooDb): SavePersonWakeDeps {
  return { startRefusal: (t) => (runnerTargetOf(db, t) ? null : engineRefusal(db, t)) }
}

/** The pump's hands, for a person's wake acted on right away. Any start this one cannot
 *  make waits for the pump's next pass, which also tells the team of a wake given up. */
function pumpDeps(db: ClawbooDb, req: Request, taskId: string): TaskWakePumpDeps {
  const mcpBaseUrl = loopbackMcpBaseUrl(req)
  const writer = ownWriterOf(req)
  return {
    held: engineHeld,
    startForPerson: (task) =>
      startTask(db, task.id, task.teamId, runnerTargetOf(db, task), mcpBaseUrl),
    pumpRoom: () => undefined,
    alert: () => false,
    asOwnWrite: (write) => runOwnWrite(db, writer, taskId, write),
  }
}

/** Act on a saved wake. A failure leaves it waiting for the pump, so it never reads as
 *  delivered or as lost: say where the words are. */
function startWake(
  db: ClawbooDb,
  req: Request,
  taskId: string,
  saved: SavedPersonWake,
): ReplyDelivery {
  if (!saved.saved) return saved.delivery
  try {
    return startPersonWake(db, taskId, saved.agentId, pumpDeps(db, req, taskId))
  } catch (err) {
    log.error({ err, taskId }, 'starting a task for a person failed')
    return { status: 'queued', agentId: saved.agentId, reason: 'next-run' }
  }
}

// ─── POST /api/board/:taskId/reopen ──────────────────────────────────────────
// A person reopens a Done or Cancelled task: back to To do, with its finish time
// cleared. The moves are person-only and not in the shared transition table, because
// every writer reads that table and the status menu lists it. A finished task's
// resume pointers are already gone, so its next run starts a fresh session and reads
// the thread in its ticket block, or the mailbox on the task runner, which has none.
// A saved wake starts it, past a ledger that ended in Stop, carrying any comment.
// `onThread` says that comment is a reply already saved on the task, which went nowhere
// because the task was finished. The reopen, its comment and its wake are one write.
export async function boardReopenPOST(req: Request, res: Response): Promise<void> {
  try {
    if (refuseUnlessDashboard(req, res)) return
    const parsed = reopenTaskBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const before = getTask(db, taskId)
    if (!before) {
      res.status(404).json({ ok: false, error: 'task not found' })
      return
    }
    const person = actingPerson(req)
    const comment = parsed.data.comment
    const reopened = runOwnWrite(db, ownWriterOf(req), taskId, () => {
      const result = before.dropped ? null : reopenTask(db, taskId)
      if (!result?.ok || !result.task) return { result, wake: null }
      const written =
        comment && parsed.data.onThread
          ? null
          : addComment(
              db,
              taskId,
              comment ?? `${person.name ?? 'A person'} reopened this task.`,
              'user',
              null,
              { person, kind: comment ? 'person' : 'note' },
            )
      // With nothing to say, a person's own task goes back to them and starts nothing,
      // and a task with no agent waits in Needs you for one.
      const task = result.task
      const wakes = comment || (!task.assigneePersonId && (runnerTargetOf(db, task) || task.teamId))
      const wake = wakes
        ? savePersonWake(
            db,
            task,
            'reopened',
            comment ? { ...(written ? { id: written.id } : {}), body: comment } : null,
            saveDeps(db),
          )
        : null
      return { result, wake }
    })
    const { result, wake } = reopened
    if (!result?.ok || !result.task) {
      res.status(409).json({
        ok: false,
        error: result?.reason === 'blocker_cancelled' ? 'blocker_cancelled' : 'not_finished',
      })
      return
    }
    emitEvent(db, {
      kind: 'status_changed',
      taskId,
      teamId: before.teamId,
      data: { to: 'todo', from: result.from, reason: 'reopened', person },
    })
    // Back in the queue: a person's move, which tells a resident engine.
    noteHumanMove(db, { taskId, teamId: before.teamId, from: result.from ?? null, to: 'todo' })
    // With nothing to say and no agent to tell, no answer is owed: Needs you shows it.
    const delivery =
      wake && (comment || wake.saved || wake.delivery.agentId)
        ? startWake(db, req, taskId, wake)
        : null
    res.json({ ok: true, task: getTask(db, taskId), ...(delivery ? { delivery } : {}) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── POST /api/board/:taskId/assign-person ───────────────────────────────────
// Give a task to a person. There is no member list, and nothing a request body says
// ever becomes a person, so the only people it can name are the sender and the person
// who asked for the task. `personId: null` takes the person off again.
export function boardAssignPersonPOST(req: Request, res: Response): void {
  try {
    if (refuseUnlessDashboard(req, res)) return
    const parsed = assignPersonBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' })
      return
    }
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    const task = getTask(db, taskId)
    if (!task) {
      res.status(404).json({ ok: false, error: 'task not found' })
      return
    }
    const me = actingPerson(req)
    const named = parsed.data.personId
    const asker = parsePersonJson(task.requestedBy)
    const person =
      named === null
        ? null
        : named === undefined || named === me.id
          ? me
          : asker?.id === named
            ? asker
            : undefined
    if (person === undefined) {
      res.status(400).json({ ok: false, error: 'unknown_person' })
      return
    }
    const ownWriter = ownWriterOf(req)
    const assigned = runOwnWrite(db, ownWriter, taskId, () =>
      assignTaskToPerson(db, taskId, person),
    )
    if (!assigned.ok) {
      res
        .status(assigned.reason === 'not_found' ? 404 : 409)
        .json({ ok: false, error: assigned.reason })
      return
    }
    // The next agent to run it, if one ever does, starts fresh: as an Assign that
    // changes the agent.
    try {
      clearTaskSessionPointers(db, taskId)
    } catch (err) {
      log.error({ err, taskId }, 'clearing the task resume pointers failed')
    }
    emitEvent(db, {
      kind: 'status_changed',
      taskId,
      teamId: task.teamId,
      data: {
        to: assigned.task.status,
        reason: person ? 'assigned_person' : 'unassigned_person',
        ...personField(req),
      },
    })
    runOwnWrite(db, ownWriter, taskId, () =>
      addComment(
        db,
        taskId,
        person
          ? `Assigned to ${person.id === me.id ? (me.name ?? 'a person') : (person.name ?? 'a person')}.`
          : 'No longer assigned to a person.',
        'user',
        null,
        { person: me, kind: 'note' },
      ),
    )
    res.json({ ok: true, task: getTask(db, taskId), attention: attentionForTask(db, taskId) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── GET /api/board/:taskId/questions ────────────────────────────────────────
export function boardQuestionsGET(req: Request, res: Response): void {
  try {
    const db = getDb()
    const taskId = (req.params['taskId'] as string | undefined) ?? ''
    if (!getTask(db, taskId)) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    res.json({ questions: listTaskQuestions(db, taskId) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/board/questions/:questionId/answer ────────────────────────────
// A person answers an agent's question. The answer is judged against expiry inside
// its own write, so an answer and an expiry never both land. It goes on the task's
// thread in the person's name, which is how the next run's ticket block carries it,
// and the agent wakes with it. The question goes there too, under the agent that wrote
// it: what a model wrote never lands in a person's words. No Tasks tool answers anything.
export async function boardQuestionAnswerPOST(req: Request, res: Response): Promise<void> {
  try {
    if (refuseUnlessDashboard(req, res)) return
    const parsed = answerQuestionBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' })
      return
    }
    const db = getDb()
    const questionId = (req.params['questionId'] as string | undefined) ?? ''
    const person = actingPerson(req)
    const asked = getQuestion(db, questionId)
    if (!asked) {
      res.status(404).json({ ok: false, error: 'not_found' })
      return
    }
    // The answer, its place on the thread and its wake are one write, so a restart
    // finds all of them or none, and the person's own answer does not read as news.
    const answered = runOwnWrite(db, ownWriterOf(req), asked.taskId, () => {
      const result = answerQuestion(db, questionId, parsed.data.answer, { person })
      if (!result.ok) return { result, wake: null, words: '' }
      const { question, task } = result
      const prompt = parseQuestionPayload(question.payload)?.prompt ?? 'your question'
      const answer = JSON.parse(question.answer ?? '{}') as QuestionAnswer
      addComment(db, task.id, askedWords(prompt), 'agent', question.agentId, { kind: 'agent' })
      const written = addComment(db, task.id, answerWords(answer), 'user', null, {
        person,
        kind: 'person',
      })
      const words = answerForAgent(prompt, answer)
      const wake = savePersonWake(
        db,
        task,
        'question_answered',
        { id: written.id, body: words },
        saveDeps(db),
      )
      return { result, wake, words }
    })
    const { result, wake } = answered
    if (!result.ok) {
      res
        .status(
          result.reason === 'not_found' ? 404 : result.reason === 'invalid_answer' ? 400 : 409,
        )
        .json({ ok: false, error: result.reason })
      return
    }
    const { question, task } = result
    for (const data of [
      { authorType: 'agent', questionId: question.id },
      { authorType: 'user', questionId: question.id, person },
    ])
      emitEvent(db, { kind: 'comment_added', taskId: task.id, teamId: task.teamId, data })
    const delivery = startWake(db, req, task.id, wake as SavedPersonWake)
    // The answer is saved. A task that stayed Blocked says so on its card, and the
    // person is never made to answer again. A run still ending starts it again in a
    // moment, so there is nothing to say.
    if (
      getTask(db, task.id)?.status === 'blocked' &&
      !listExecutions(db, task.id).some((e) => e.status === 'running')
    ) {
      noteBlockedReason(db, task.id, {
        kind: 'person',
        need:
          delivery.status === 'not-delivered'
            ? 'Your answer is saved on this task, but it could not start the agent. Retry it, or give it to an agent.'
            : 'Your answer is saved on this task. Its agent gets it as soon as the task can start.',
      })
    }
    res.json({
      ok: true,
      question: getQuestion(db, question.id),
      task: getTask(db, task.id),
      delivery,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
