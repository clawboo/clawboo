// Questions to a person: the task_questions rows and what they do to the task.

import { LOCAL_PERSON, parseWaitingOn } from '@clawboo/board-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { attentionForTask } from '../attention'
import {
  answerQuestion,
  askQuestion,
  listTaskQuestions,
  pendingQuestionsForTasks,
  personCommentedSinceAsked,
} from '../questions'
import { addComment, claimTask, createTask, dropTask, getTask, updateStatus } from '../repository'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const BOUND = 'run-1:deleg:agent:a2:reflectTo:leader'

function claimed(extra: { scheduledBy?: string } = {}): string {
  const t = createTask(db, {
    title: 'Write it',
    teamId: 'T',
    status: 'todo',
    sourceDelegationId: BOUND,
    ...extra,
  })
  expect(claimTask(db, t.id, 'a2').ok).toBe(true)
  return t.id
}

const ask = (taskId: string, prompt = 'Which colour?', key?: string) =>
  askQuestion(db, {
    taskId,
    agentId: 'a2',
    kind: 'question',
    payload: { prompt, options: ['Red', 'Blue'] },
    ...(key ? { idempotencyKey: key } : {}),
  })

describe('asking', () => {
  it('blocks the task with waiting_on set to the question', () => {
    const id = claimed()
    const r = ask(id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.question.status).toBe('pending')
    const row = getTask(db, id)
    expect(row?.status).toBe('blocked')
    expect(parseWaitingOn(row?.waitingOn)).toEqual({ kind: 'question', questionId: r.question.id })
    expect(attentionForTask(db, id)).toMatchObject({
      reason: 'question',
      questionId: r.question.id,
    })
  })

  it('a repeated call with one key asks once', () => {
    const id = claimed()
    const first = ask(id, 'Which colour?', 'k1')
    const again = ask(id, 'Which colour?', 'k1')
    expect(first.ok && again.ok).toBe(true)
    if (!first.ok || !again.ok) return
    expect(again.question.id).toBe(first.question.id)
    expect(again.existing).toBe(true)
    expect(listTaskQuestions(db, id)).toHaveLength(1)
  })

  it('a newer question replaces the one still open', () => {
    const id = claimed()
    const first = ask(id, 'One?')
    const second = ask(id, 'Two?')
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const rows = listTaskQuestions(db, id)
    expect(rows.map((q) => q.status)).toEqual(['expired', 'pending'])
    expect(rows[0]?.closeReason).toBe('replaced')
    expect(parseWaitingOn(getTask(db, id)?.waitingOn)).toEqual({
      kind: 'question',
      questionId: second.question.id,
    })
  })

  it('only the agent on the task may ask, and not after it closed', () => {
    const id = claimed()
    expect(
      askQuestion(db, { taskId: id, agentId: 'a9', kind: 'confirm', payload: { prompt: 'x' } }),
    ).toMatchObject({ ok: false, reason: 'not_yours' })
    updateStatus(db, id, 'done')
    expect(ask(id)).toMatchObject({ ok: false, reason: 'finished' })
    expect(ask('nope')).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('a routine’s task does not ask: its person may be away', () => {
    const id = claimed({ scheduledBy: 'clawboo' })
    expect(ask(id)).toMatchObject({ ok: false, reason: 'routine' })
    expect(getTask(db, id)?.status).toBe('in_progress')
  })

  it('a person’s move overrules a question from the run it stopped', () => {
    const id = claimed()
    updateStatus(db, id, 'blocked', { actor: 'person' })
    expect(ask(id)).toMatchObject({ ok: false, reason: 'person_moved' })
  })
})

describe('a person’s comment against a question, by row order', () => {
  const asked = (taskId: string) => {
    const r = ask(taskId)
    if (!r.ok) throw new Error(r.reason)
    return r.question
  }
  const fromPerson = (taskId: string) => addComment(db, taskId, 'Words', 'user', null).id

  it('one written before it is before it, and one written after is after', () => {
    const id = claimed()
    const before = fromPerson(id)
    const question = asked(id)
    const after = fromPerson(id)
    expect(personCommentedSinceAsked(db, question, [before])).toBe(false)
    expect(personCommentedSinceAsked(db, question, [after])).toBe(true)
    expect(personCommentedSinceAsked(db, question, [before, after])).toBe(true)
    expect(personCommentedSinceAsked(db, question, [])).toBe(false)
  })

  it('with no comment on the task yet, the next one is after it', () => {
    const id = claimed()
    const question = asked(id)
    expect(question.commentMark).toBe(0)
    expect(personCommentedSinceAsked(db, question, [fromPerson(id)])).toBe(true)
  })

  it('another task’s comments do not move the mark, and an agent’s is not a person’s', () => {
    const id = claimed()
    const other = claimed()
    fromPerson(other)
    const question = asked(id)
    expect(question.commentMark).toBe(0)
    const agents = addComment(db, id, 'Words', 'agent', 'a3').id
    expect(personCommentedSinceAsked(db, question, [agents])).toBe(false)
  })

  it('a question from before the mark existed goes by the clock', () => {
    const id = claimed()
    const question = { ...asked(id), commentMark: null }
    const after = fromPerson(id)
    expect(
      personCommentedSinceAsked(db, { ...question, createdAt: Date.now() + 60_000 }, [after]),
    ).toBe(false)
    expect(personCommentedSinceAsked(db, { ...question, createdAt: 0 }, [after])).toBe(true)
  })
})

describe('answering', () => {
  function asked(prompt = 'Which colour?'): { taskId: string; questionId: string } {
    const taskId = claimed()
    const r = ask(taskId, prompt)
    if (!r.ok) throw new Error('ask failed')
    return { taskId, questionId: r.question.id }
  }

  it('records the answer and who gave it, and clears the reason in one write', () => {
    const { taskId, questionId } = asked()
    const r = answerQuestion(db, questionId, { choice: 'Blue' }, { person: LOCAL_PERSON })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.question.status).toBe('answered')
    expect(JSON.parse(r.question.answer ?? '{}')).toEqual({ kind: 'question', choice: 'Blue' })
    expect(JSON.parse(r.question.answeredBy ?? '{}')).toEqual(LOCAL_PERSON)
    expect(r.question.answeredAt).toBeTypeOf('number')
    // Still Blocked: the wake moves it, so a crash in between leaves it to a person.
    expect(getTask(db, taskId)?.status).toBe('blocked')
    expect(getTask(db, taskId)?.waitingOn).toBeNull()
  })

  it('a second answer loses', () => {
    const { questionId } = asked()
    expect(answerQuestion(db, questionId, { choice: 'Red' }, { person: LOCAL_PERSON }).ok).toBe(
      true,
    )
    expect(answerQuestion(db, questionId, { choice: 'Blue' }, { person: LOCAL_PERSON })).toEqual({
      ok: false,
      reason: 'answered',
    })
  })

  it('refuses an answer the question does not allow', () => {
    const { questionId } = asked()
    expect(answerQuestion(db, questionId, { choice: 'Green' }, { person: LOCAL_PERSON })).toEqual({
      ok: false,
      reason: 'invalid_answer',
    })
    expect(answerQuestion(db, 'nope', { choice: 'Red' }, { person: LOCAL_PERSON })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('takes a yes or no for a confirmation, and an edited list for suggested tasks', () => {
    const a = claimed()
    const confirm = askQuestion(db, {
      taskId: a,
      agentId: 'a2',
      kind: 'confirm',
      payload: { prompt: 'Delete the branch?' },
    })
    if (!confirm.ok) throw new Error('ask failed')
    expect(
      answerQuestion(db, confirm.question.id, { confirmed: false }, { person: LOCAL_PERSON }).ok,
    ).toBe(true)

    const b = claimed()
    const suggest = askQuestion(db, {
      taskId: b,
      agentId: 'a2',
      kind: 'suggest_tasks',
      payload: { prompt: 'Split it so?', tasks: [{ title: 'One' }, { title: 'Two' }] },
    })
    if (!suggest.ok) throw new Error('ask failed')
    const r = answerQuestion(
      db,
      suggest.question.id,
      { accepted: true, tasks: [{ title: 'One, reworded' }] },
      { person: LOCAL_PERSON },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.question.answer ?? '{}')).toEqual({
      kind: 'suggest_tasks',
      accepted: true,
      tasks: [{ title: 'One, reworded' }],
    })
  })
})

describe('expiry is on events, not a clock', () => {
  function asked(): { taskId: string; questionId: string } {
    const taskId = claimed()
    const r = ask(taskId)
    if (!r.ok) throw new Error('ask failed')
    return { taskId, questionId: r.question.id }
  }

  it('a closed task expires its open questions', () => {
    for (const end of ['done', 'cancelled'] as const) {
      const { taskId, questionId } = asked()
      // A question parks the task in Blocked; a person ends it from there.
      updateStatus(db, taskId, 'todo', { actor: 'person' })
      if (end === 'cancelled') updateStatus(db, taskId, 'cancelled', { actor: 'person' })
      const [q] = listTaskQuestions(db, taskId)
      expect(q?.id).toBe(questionId)
      expect(q?.status, end).toBe('expired')
    }
    const { taskId } = asked()
    updateStatus(db, taskId, 'cancelled', { actor: 'person' })
    expect(listTaskQuestions(db, taskId)[0]?.status).toBe('expired')
    expect(listTaskQuestions(db, taskId)[0]?.closeReason).toBe('task_closed')
  })

  it('a dropped task expires them too', () => {
    const { taskId } = asked()
    dropTask(db, taskId)
    expect(listTaskQuestions(db, taskId)[0]?.status).toBe('expired')
  })

  it('a task moved on (a Retry, a person’s move) expires its question', () => {
    const { taskId } = asked()
    updateStatus(db, taskId, 'todo')
    expect(listTaskQuestions(db, taskId)[0]?.status).toBe('expired')
    expect(listTaskQuestions(db, taskId)[0]?.closeReason).toBe('moved')
  })

  it('an answer racing the expiry loses cleanly', () => {
    const { taskId, questionId } = asked()
    updateStatus(db, taskId, 'cancelled', { actor: 'person' })
    expect(answerQuestion(db, questionId, { choice: 'Red' }, { person: LOCAL_PERSON })).toEqual({
      ok: false,
      reason: 'expired',
    })
    const [q] = listTaskQuestions(db, taskId)
    expect(q?.answer).toBeNull()
    expect(q?.answeredBy).toBeNull()
    expect(getTask(db, taskId)?.status).toBe('cancelled')
  })

  it('judges a task that closed by a write no expiry saw, inside the answer’s own write', () => {
    const { taskId, questionId } = asked()
    // A raw writer closed the task and left the row pending.
    db.$client.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ?`).run(taskId)
    expect(answerQuestion(db, questionId, { choice: 'Red' }, { person: LOCAL_PERSON })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(listTaskQuestions(db, taskId)[0]?.status).toBe('expired')
    expect(listTaskQuestions(db, taskId)[0]?.answer).toBeNull()
  })
})

describe('reads', () => {
  it('finds the question each waiting task has open', () => {
    const a = claimed()
    const b = claimed()
    const asked = ask(a)
    if (!asked.ok) throw new Error('ask failed')
    const map = pendingQuestionsForTasks(db, [a, b])
    expect(map.get(a)?.id).toBe(asked.question.id)
    expect(map.has(b)).toBe(false)
    expect(pendingQuestionsForTasks(db, []).size).toBe(0)
  })
})
