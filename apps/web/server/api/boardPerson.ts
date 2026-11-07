// ─── A person's own writes on the board ─────────────────────────────────────
// Reopen, assign to a person, answer a question. Each is a person-only route: under
// /api/ (so the access gate and the origin guard apply) and never under /api/mcp/,
// where a runtime's attach token gets in without the cookie. Each answers to the one
// person check (`refuseUnlessPerson`), and records the verified person, or the
// install's built-in one, as who did it. Behind a sign-in proxy in `required` mode
// every request here needs a verified person anyway. Locally it stays the speed bump
// that check is: see lib/dashboardRequest.

import type { Request, Response } from 'express'

import { parseWaitingOn, type AgentWakeChoice } from '@clawboo/board-core'
import {
  addComment,
  agentCommentWakesOfJob,
  agentWakesBody,
  carryOnJob,
  jobLimitBody,
  jobLimitedTaskIds,
  jobRunState,
  answerForAgent,
  answerQuestion,
  answerWords,
  askedWords,
  answerQuestionBody,
  appendAudit,
  assignPersonBody,
  assignTaskToPerson,
  attentionForTask,
  decideAgentWakes,
  emitBoardLifecycle,
  getQuestion,
  getTask,
  listExecutions,
  listTaskQuestions,
  stopJob,
  tasksOfJob,
  noteBlockedReason,
  parsePersonJson,
  parseQuestionPayload,
  readAgentWakeGate,
  reopenTask,
  reopenTaskBody,
  runOwnWrite,
  markTaskRead,
  activitySeqOf,
  type ClawbooDb,
  type QuestionAnswer,
  startRefusedByTask,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { personCommentReport } from '@clawboo/team-orchestration'

import { actingPerson, actorField, refuseUnlessPerson } from '../lib/auth'
import { markReleasedTasksRead, ownWriterOf } from '../lib/boardReader'
import { getDb } from '../lib/db'
import { engineHeld } from '../lib/engineHold'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { emitEvent } from '../lib/obs'
import { cancelRunnerRerun } from '../lib/runnerRerun'
import { runnerTargetOf } from '../lib/runnerRoute'
import { stopTaskRuns, whenTaskRunsEnd } from '../lib/runStops'
import { startTask } from '../lib/startBoardTask'
import { pumpRoomOfTask } from '../lib/teamChat/boardDispatch'
import { noteHumanMove } from '../lib/teamChat/humanMove'
import type { ReplyDelivery } from '../lib/teamChat/personReply'
import {
  savePersonWake,
  startPersonWake,
  type SavedPersonWake,
  type SavePersonWakeDeps,
} from '../lib/teamChat/personWake'
import { createChatReportUps, notifyChatReportUp } from '../lib/agentChat/chatReportUpOutbox'
import { createReportUpOutbox } from '../lib/teamChat/reportUpOutbox'
import { engineRefusal, roomIdForTask, startRefusal } from '../lib/teamChat/roomRoster'
import { writeRequestNote } from '../lib/teamChat/requestNote'
import { getTaskOrchestrator, stopJobTeamRuns } from '../lib/teamChat/teamOrchestrator'
import { pumpTaskWakeNow, type TaskWakePumpDeps } from '../lib/teamChat/taskWakes'
import { clearTaskSessionPointers } from '../lib/teamChat/taskSessionPointers'

const log = createLogger('board-person')

/** What a person's Stop on a job's card says on the card it was pressed on. */
const JOB_STOPPED_BY_PERSON =
  'Stop: this job’s runs have ended and nothing under it starts by itself. A Retry or a comment starts work again.'
/** What it says on each run it ended. */
const JOB_STOPPED_NOTE = 'A person stopped this job.'

/** What a reopened request's lead reads when the person gave no words of their own. */
const REOPENED_REQUEST = 'A person reopened this request.'

/** What saving a person's wake needs: as Retry, team chat could not run a task its
 *  engine cannot see. */
function saveDeps(db: ClawbooDb): SavePersonWakeDeps {
  return { startRefusal: (t) => startRefusal(db, t, runnerTargetOf(db, t) !== null) }
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
    startByItself: (task) =>
      startTask(db, task.id, task.teamId, runnerTargetOf(db, task), mcpBaseUrl, {
        automatic: true,
      }),
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
    if (refuseUnlessPerson(req, res)) return
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
      // A main task has no run to wake: its lead hears, in this same write, so nothing
      // can read the reopened request as one with no one left to answer it. An engine
      // built for this runs its own first pass before anything else reaches it.
      if (before.isMainTask === 1) {
        if (comment && !parsed.data.onThread)
          addComment(db, taskId, comment, 'user', null, { person, kind: 'person' })
        else if (!comment)
          addComment(db, taskId, REOPENED_REQUEST, 'user', null, { person, kind: 'note' })
        const refusal = engineRefusal(db, result.task)
        if (!refusal && before.teamId) {
          const report = personCommentReport(
            { id: taskId, title: before.title, leadAgentId: result.task.assigneeAgentId },
            comment ?? REOPENED_REQUEST,
          )
          // A request from a one-to-one chat is answered there, not in a team session.
          if (!createChatReportUps(db, before.teamId as string).take(report, { held: false }))
            createReportUpOutbox(db, before.teamId as string, roomIdForTask(db, taskId)).record(
              report,
            )
        }
        return { result, wake: null, requestRefusal: refusal }
      }
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
      data: {
        to: result.task.status,
        from: result.from,
        reason: 'reopened',
        person,
        actor: { kind: 'person' },
      },
    })
    // Reopened, a request waits on its lead again. Its lead's reply closes it again unless
    // the person's words give it more to do.
    if (before.isMainTask === 1) {
      const lead = result.task.assigneeAgentId
      const refusal = reopened.requestRefusal ?? null
      // The lead's answer lands in the chat, which has to say what it answers.
      if (!refusal && before.teamId && lead)
        writeRequestNote(
          db,
          result.task,
          { teamId: before.teamId, roomId: roomIdForTask(db, taskId), agentId: lead },
          `A person reopened ${before.identifier ?? `“${before.title}”`}${comment ? `: ${comment}` : '.'}`,
        )
      if (!refusal && before.teamId)
        void getTaskOrchestrator(before.teamId, taskId, { mcpBaseUrl: loopbackMcpBaseUrl(req), db })
          .pump()
          .catch((err: unknown) => log.error({ err, taskId }, 'pumping a reopened request failed'))
      const delivery: ReplyDelivery = refusal
        ? { status: 'not-delivered', agentId: lead, reason: refusal }
        : !lead
          ? { status: 'not-delivered', agentId: null, reason: 'unassigned' }
          : engineHeld()
            ? { status: 'queued', agentId: lead, reason: 'held' }
            : startRefusedByTask(db, result.task)
              ? { status: 'queued', agentId: lead, reason: 'paused' }
              : { status: 'woke-agent', agentId: lead }
      res.json({ ok: true, task: getTask(db, taskId), delivery })
      return
    }
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
    if (refuseUnlessPerson(req, res)) return
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
        ...actorField(req),
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

// ─── POST /api/board/agent-wakes/:jobTaskId ──────────────────────────────────
// What a person pressed on the card about agents waking each other on a job: allow it
// on this job, always in this team, or no. A yes also lifts a pause, and starts what
// was waiting for it. No Tasks tool can answer it: the agents are who it is about.
const AGENT_WAKES_NOTE: Record<AgentWakeChoice, string> = {
  job: 'Agents may wake each other on this job.',
  team: 'Agents may wake each other in this team, without asking.',
  no: 'Agents do not wake each other on this job.',
}

export function boardAgentWakesPOST(req: Request, res: Response): void {
  try {
    if (refuseUnlessPerson(req, res)) return
    const parsed = agentWakesBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' })
      return
    }
    const db = getDb()
    const jobTaskId = (req.params['jobTaskId'] as string | undefined) ?? ''
    if (!getTask(db, jobTaskId)) {
      res.status(404).json({ ok: false, error: 'task not found' })
      return
    }
    const choice = parsed.data.decision
    const person = actingPerson(req)
    const shownOn = readAgentWakeGate(db, jobTaskId)?.cardTaskId ?? jobTaskId
    const result = runOwnWrite(db, ownWriterOf(req), shownOn, () => {
      const decided = decideAgentWakes(db, jobTaskId, choice, person)
      if (decided.ok)
        addComment(db, shownOn, AGENT_WAKES_NOTE[choice], 'user', null, { person, kind: 'note' })
      return decided
    })
    if (!result.ok) {
      res.status(409).json({ ok: false, error: result.reason })
      return
    }
    const task = getTask(db, shownOn)
    appendAudit(db, {
      eventType: 'board',
      taskId: shownOn,
      teamId: task?.teamId ?? null,
      summary: { agentWakes: choice, jobTaskId: result.jobTaskId, ...actorField(req) },
    })
    // Start what waited on this answer, as far as this request can. The pump's next pass
    // does the rest, which its own event brings within seconds.
    if (choice !== 'no')
      for (const row of result.jobTaskIds.flatMap((job) => agentCommentWakesOfJob(db, job))) {
        try {
          pumpTaskWakeNow(db, row.taskId, pumpDeps(db, req, row.taskId))
        } catch (err) {
          log.error({ err, taskId: row.taskId }, 'starting a teammate’s wake failed')
        }
        emitBoardLifecycle({
          kind: 'task_wake_recorded',
          taskId: row.taskId,
          teamId: row.teamId,
          reason: 'agent_comment',
        })
      }
    res.json({ ok: true, task: getTask(db, shownOn), attention: attentionForTask(db, shownOn) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── POST /api/board/job-limit/:jobTaskId ────────────────────────────────────
// A job started all the runs it may by itself, and a person answers. Carry on adds another
// lot. Stop is about this job alone: its live runs end, on the team's engine and the task
// runner, nothing under it starts by itself, and the card stays down until a person starts
// work in it again. Other work in the room goes on. Person-only, since an agent answering
// this would be a job lifting its own limit.
export async function boardJobLimitPOST(req: Request, res: Response): Promise<void> {
  try {
    if (refuseUnlessPerson(req, res)) return
    const parsed = jobLimitBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' })
      return
    }
    const db = getDb()
    const jobTaskId = (req.params['jobTaskId'] as string | undefined) ?? ''
    const task = getTask(db, jobTaskId)
    if (!task) {
      res.status(404).json({ ok: false, error: 'task not found' })
      return
    }
    const decision = parsed.data.decision
    const state = jobRunState(db, jobTaskId)
    if (state.jobTaskId !== jobTaskId || !jobLimitedTaskIds(db).includes(jobTaskId)) {
      res.status(409).json({ ok: false, error: 'no_card' })
      return
    }
    if (decision === 'stop') {
      const person = actingPerson(req)
      const writer = ownWriterOf(req)
      // What this moves, read first. None of it is news to the person pressing it.
      const moving = writer
        ? tasksOfJob(db, jobTaskId).filter((id) => {
            const t = getTask(db, id)
            return (
              t?.status === 'in_progress' ||
              t?.status === 'in_review' ||
              (t?.status === 'blocked' && parseWaitingOn(t.waitingOn)?.kind === 'subtasks')
            )
          })
        : []
      const result = runOwnWrite(db, writer, jobTaskId, () => {
        const stopped = stopJob(db, jobTaskId, person)
        if (stopped.ok)
          addComment(db, jobTaskId, JOB_STOPPED_BY_PERSON, 'user', null, { person, kind: 'note' })
        return stopped
      })
      if (!result.ok) {
        res.status(409).json({ ok: false, error: result.reason })
        return
      }
      const under = new Set(result.taskIds)
      const onRunner: string[] = []
      for (const id of under) {
        if (stopTaskRuns(id, JOB_STOPPED_NOTE)) onRunner.push(id)
        cancelRunnerRerun(id)
      }
      // An engine not loaded has no runs, and what it would start is marked already.
      await stopJobTeamRuns(under, { task: JOB_STOPPED_NOTE, turn: JOB_STOPPED_NOTE })
      if (writer) {
        markReleasedTasksRead(db, writer, moving)
        // The runner's run writes its own ending, once its abort has reached it.
        for (const id of onRunner) {
          whenTaskRunsEnd(id, () => markReleasedTasksRead(db, writer, [id]))
        }
      }
      emitEvent(db, {
        kind: 'status_changed',
        taskId: jobTaskId,
        teamId: task.teamId,
        data: { to: task.status, reason: 'job_stopped', by: 'person', ...actorField(req) },
      })
    } else {
      const person = actingPerson(req)
      const result = runOwnWrite(db, ownWriterOf(req), jobTaskId, () => {
        const carried = carryOnJob(db, jobTaskId, person)
        if (carried.ok)
          addComment(
            db,
            jobTaskId,
            `Carry on: this job may start up to ${carried.limit} runs by itself.`,
            'user',
            null,
            { person, kind: 'note' },
          )
        return carried
      })
      if (!result.ok) {
        res.status(409).json({ ok: false, error: result.reason })
        return
      }
      emitEvent(db, {
        kind: 'job_limit_carried_on',
        taskId: jobTaskId,
        teamId: task.teamId,
        data: { runs: result.runs, limit: result.limit, ...actorField(req) },
      })
      if (task.teamId) pumpRoomOfTask(task.teamId, jobTaskId, loopbackMcpBaseUrl(req))
    }
    appendAudit(db, {
      eventType: 'board',
      taskId: jobTaskId,
      teamId: task.teamId,
      summary: { jobLimit: decision, jobTaskId, ...actorField(req) },
    })
    res.json({ ok: true, task: getTask(db, jobTaskId), attention: attentionForTask(db, jobTaskId) })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
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
    if (refuseUnlessPerson(req, res)) return
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
    const writer = ownWriterOf(req)
    const answered = runOwnWrite(db, writer, asked.taskId, () => {
      const result = answerQuestion(db, questionId, parsed.data.answer, { person })
      if (!result.ok) return { result, wake: null, words: '' }
      // The steps an acceptance creates are this person's own doing too, so they read as
      // new only once someone else changes them.
      if (writer)
        for (const made of result.created ?? [])
          markTaskRead(db, writer, made.id, activitySeqOf(db, made.id))
      const { question, task } = result
      const payload = parseQuestionPayload(question.payload)
      const prompt = payload?.prompt ?? 'your question'
      const answer = JSON.parse(question.answer ?? '{}') as QuestionAnswer
      // A plan's tasks exist by now, so the words must not read as asking for them.
      const planCreated = { planCreated: payload?.plan !== undefined }
      addComment(db, task.id, askedWords(prompt), 'agent', question.agentId, {
        kind: 'agent',
        executionId: question.executionId,
      })
      const written = addComment(db, task.id, answerWords(answer, planCreated), 'user', null, {
        person,
        kind: 'person',
      })
      const words = answerForAgent(prompt, answer, planCreated)
      // A card that only held a plan closed with this answer, and its agent hears through
      // the update written with it, in its own session. Nothing runs on the card.
      const wake = payload?.plan?.holder
        ? null
        : savePersonWake(
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
          result.reason === 'not_found'
            ? 404
            : result.reason === 'invalid_answer' || result.reason === 'too_many_steps'
              ? 400
              : 409,
        )
        .json({
          ok: false,
          error: result.reason,
          ...('room' in result ? { room: result.room } : {}),
          ...('max' in result ? { max: result.max } : {}),
        })
      return
    }
    const { question, task } = result
    const asker = question.agentId
      ? ({ kind: 'agent', agentId: question.agentId, execId: question.executionId } as const)
      : ({ kind: 'caller' } as const)
    // An accepted plan's steps, for the board's readers and what they wake. A person's
    // acceptance is what made them.
    for (const made of result.created ?? [])
      emitEvent(db, {
        kind: 'task_created',
        taskId: made.id,
        teamId: made.teamId,
        data: {
          title: made.title,
          status: made.status,
          parentTaskId: made.parentTaskId,
          ...actorField(req),
        },
      })
    // A card that only held the plan closed with this answer, by this person.
    if (parseQuestionPayload(question.payload)?.plan?.holder)
      emitEvent(db, {
        kind: 'status_changed',
        taskId: task.id,
        teamId: task.teamId,
        data: { to: task.status, reason: 'plan_answered', ...actorField(req) },
      })
    for (const data of [
      { authorType: 'agent', questionId: question.id, actor: asker },
      { authorType: 'user', questionId: question.id, person, actor: { kind: 'person' } as const },
    ])
      emitEvent(db, { kind: 'comment_added', taskId: task.id, teamId: task.teamId, data })
    const delivery: ReplyDelivery = wake
      ? startWake(db, req, task.id, wake)
      : { status: 'queued', agentId: question.agentId ?? '', reason: 'next-run' }
    if (!wake && task.teamId) pumpRoomOfTask(task.teamId, task.id, loopbackMcpBaseUrl(req))
    // A plan from a one-to-one chat: the answer's row is that chat's to send.
    if (!wake && task.chatSessionKey) notifyChatReportUp(task.chatSessionKey)
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
            : delivery.status === 'queued' && delivery.reason === 'paused'
              ? 'Your answer is saved on this task. Its agent gets it after the resume.'
              : 'Your answer is saved on this task. Its agent gets it as soon as the task can start.',
      })
    }
    res.json({
      ok: true,
      question: getQuestion(db, question.id),
      task: getTask(db, task.id),
      delivery,
      ...(result.created || result.linked
        ? { created: result.created?.length ?? 0, alreadyOpen: result.linked?.length ?? 0 }
        : {}),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
