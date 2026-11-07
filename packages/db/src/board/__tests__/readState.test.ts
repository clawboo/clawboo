// A person's read state: what "unread" means, at the database. Unread means
// someone else changed or commented on a task since this reader last opened it.
// The triggers record every change, whichever path or process wrote it; a
// reader's marks say how far they have read.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LOCAL_PERSON, TASK_STATUSES, type TaskStatus } from '@clawboo/board-core'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDb, openDb, type ClawbooDb } from '../../db'
import type { PersonRecord } from '../../person'
import { ensureSchema } from '../../schemaBootstrap'
import { recordTaskWake } from '../../taskWakes'
import { attentionForTasks, taskIdsNeedingPerson } from '../attention'
import { liftPause, placePause } from '../pauses'
import {
  addComment,
  claimTask,
  createTask,
  dropTask,
  heartbeatTask,
  listTasks,
  updateStatus,
  updateTaskFields,
} from '../repository'
import {
  boardActivityHead,
  LOCAL_READER,
  markAllTasksRead,
  markTaskRead,
  readerLastRead,
  readerOfPerson,
  runOwnWrite,
  taskReadStates,
  unreadTasks,
} from '../readState'
import { taskReaders, teams } from '../../schema'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-read-state-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const unreadIds = (reader: string = LOCAL_READER): string[] =>
  unreadTasks(db, reader).map((t) => t.id)
const stateOf = (id: string, reader: string = LOCAL_READER) => taskReadStates(db, reader).get(id)
const seqOf = (id: string): number => stateOf(id)?.activity?.seq ?? 0

/** A task this reader has caught up with, so what follows is the only news. */
function readTask(title = 'Write the post', reader: string = LOCAL_READER): string {
  const task = createTask(db, { title, status: 'todo' })
  markTaskRead(db, reader, task.id, seqOf(task.id))
  return task.id
}

describe('a run a person’s wake starts', () => {
  const claim = (taskId: string) =>
    claimTask(db, taskId, 'a1', 'codex', { run: { executorType: 'codex' } })

  /** A person's comment on a task, as the comment route writes it, and its wake. */
  const comment = (taskId: string, reader: string, person: PersonRecord | null = null): void => {
    const written = runOwnWrite(db, reader, taskId, () =>
      addComment(db, taskId, 'try the other file', 'user', null, { kind: 'person', person }),
    )
    recordTaskWake(db, {
      teamId: 'T',
      agentId: 'a1',
      taskId,
      reason: 'person_comment',
      commentIds: [written.id],
    })
  }

  it('reads as theirs when its claim takes the wake, and what follows is news', () => {
    const id = readTask()
    comment(id, LOCAL_READER)
    expect(claim(id).ok).toBe(true)
    expect(stateOf(id)).toMatchObject({ unread: false, activity: { kind: 'status' } })

    addComment(db, id, 'found it', 'agent', 'a1', { kind: 'agent' })
    expect(unreadIds()).toEqual([id])
  })

  it('leaves unread what they had not read', () => {
    const id = readTask()
    comment(id, LOCAL_READER)
    addComment(db, id, 'found it', 'agent', 'a1', { kind: 'agent' })
    claim(id)
    expect(unreadIds()).toEqual([id])
  })

  it('reads as theirs for the person the comment names, and as news for anyone else', () => {
    const reader = readerOfPerson({ id: 'p-priya' })
    const other = readerOfPerson({ id: 'p-sam' })
    const id = readTask('Write the post', reader)
    unreadIds(other) // caught up from here on
    comment(id, reader, { id: 'p-priya', name: 'Priya', role: null })
    claim(id)
    expect(unreadIds(reader)).toEqual([])
    expect(unreadIds(other)).toEqual([id])
  })

  it('is news when the claim takes no wake, or one no person is behind', () => {
    const bare = readTask()
    claim(bare)
    expect(unreadIds()).toEqual([bare])

    const fromWork = readTask('Next step')
    recordTaskWake(db, { teamId: 'T', agentId: 'a1', taskId: fromWork, reason: 'dependency_done' })
    claim(fromWork)
    expect(unreadIds()).toContain(fromWork)
  })

  it('is news for a claim that opens no run, which takes no wake', () => {
    const id = readTask()
    comment(id, LOCAL_READER)
    claimTask(db, id, 'a1')
    expect(unreadIds()).toEqual([id])
  })

  it('reads as theirs when the comment names the built-in person, as an answer does', () => {
    const id = readTask()
    comment(id, LOCAL_READER, { ...LOCAL_PERSON })
    expect(claim(id).ok).toBe(true)
    expect(unreadIds()).toEqual([])
    expect(readerOfPerson({ ...LOCAL_PERSON })).toBe(LOCAL_READER)
    expect(
      db
        .select()
        .from(taskReaders)
        .all()
        .map((r) => r.readerId),
    ).toEqual([LOCAL_READER])
  })

  it('a claim a pause refuses marks nothing, and the one after the resume reads as theirs', () => {
    const id = readTask()
    comment(id, LOCAL_READER)
    placePause(db, { kind: 'agent', id: 'a1' })
    addComment(db, id, 'found it', 'agent', 'a2', { kind: 'agent' })
    expect(claim(id)).toMatchObject({ ok: false, reason: 'paused' })
    expect(unreadIds()).toEqual([id])

    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    liftPause(db, 'agent', 'a1')
    expect(claim(id).ok).toBe(true)
    expect(unreadIds()).toEqual([])
  })

  it('a resume’s claim with no person’s wake is news', () => {
    const id = readTask()
    placePause(db, { kind: 'agent', id: 'a1' })
    expect(claim(id)).toMatchObject({ ok: false, reason: 'paused' })
    expect(unreadIds()).toEqual([])
    liftPause(db, 'agent', 'a1')
    expect(claim(id).ok).toBe(true)
    expect(unreadIds()).toEqual([id])
  })

  it('reads the same whoever claims it: the wake says whose it is, not the claimer', () => {
    const id = readTask()
    comment(id, LOCAL_READER)
    const claimed = claimTask(db, id, 'a1', 'claude-code', {
      run: { executorType: 'openclaw', engineRun: true },
    })
    expect(claimed.execution).toMatchObject({ engineRun: 1 })
    expect(unreadIds()).toEqual([])
  })

  it('a teammate’s wake taken with a person’s leaves what the teammate said unread', () => {
    const id = readTask()
    comment(id, LOCAL_READER)
    const said = addComment(db, id, 'here is the key', 'agent', 'a2', { kind: 'agent' })
    recordTaskWake(db, {
      teamId: 'T',
      agentId: 'a1',
      taskId: id,
      reason: 'agent_comment',
      commentIds: [said.id],
    })
    expect(claim(id).ok).toBe(true)
    expect(unreadIds()).toEqual([id])
  })
})

describe('what counts as a change', () => {
  it('a new task from someone else is unread', () => {
    const task = createTask(db, { title: 'Agent made this', status: 'todo' })
    expect(unreadIds()).toEqual([task.id])
    expect(stateOf(task.id)).toMatchObject({ unread: true, activity: { kind: 'created' } })
  })

  it('an agent’s comment is unread, and opening clears it, and the next one brings it back', () => {
    const id = readTask()
    expect(unreadIds()).toEqual([])

    addComment(db, id, 'Halfway there.', 'agent', 'coder')
    expect(unreadIds()).toEqual([id])
    expect(stateOf(id)?.activity?.kind).toBe('comment')

    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    expect(unreadIds()).toEqual([])

    addComment(db, id, 'Done now.', 'agent', 'coder')
    expect(unreadIds()).toEqual([id])
  })

  it('a move by an agent is unread and says what moved', () => {
    const id = readTask()
    expect(claimTask(db, id, 'coder').ok).toBe(true)
    expect(unreadIds()).toEqual([id])
    expect(stateOf(id)?.activity?.kind).toBe('status')
  })

  it('an edit to what the task says is unread', () => {
    const id = readTask()
    updateTaskFields(db, id, { title: 'A better title' })
    expect(unreadIds()).toEqual([id])
    expect(stateOf(id)?.activity?.kind).toBe('edited')
  })

  it('the heartbeat of a running task is not a change, though it moves updatedAt', () => {
    const id = readTask()
    expect(claimTask(db, id, 'coder').ok).toBe(true)
    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    heartbeatTask(db, id, { assigneeAgentId: 'coder' })
    expect(unreadIds()).toEqual([])
  })

  it('writing the same status or the same fields again is not a change', () => {
    const id = readTask()
    updateTaskFields(db, id, { title: 'Write the post', priority: 0 })
    updateTaskFields(db, id, { assigneeRuntime: 'codex' })
    expect(unreadIds()).toEqual([])
  })

  it('the app’s own notes are not a change, so a stopped run does not echo as news', () => {
    const id = readTask()
    addComment(db, id, 'Stopped: a person moved the card to Done.', 'system')
    expect(unreadIds()).toEqual([])
  })

  it('a dropped task leaves the list', () => {
    const task = createTask(db, { title: 'Gone soon', status: 'todo' })
    expect(unreadIds()).toEqual([task.id])
    dropTask(db, task.id)
    expect(unreadIds()).toEqual([])
  })
})

describe('own writes', () => {
  it('a person’s own comment or move does not make the task unread for them', () => {
    const id = readTask()
    runOwnWrite(db, LOCAL_READER, id, () => addComment(db, id, 'Lead with pricing.', 'user'))
    expect(unreadIds()).toEqual([])
    runOwnWrite(db, LOCAL_READER, id, () => updateStatus(db, id, 'blocked', { actor: 'person' }))
    expect(unreadIds()).toEqual([])
  })

  it('an agent’s progress after it is unread', () => {
    const id = readTask()
    runOwnWrite(db, LOCAL_READER, id, () => addComment(db, id, 'Lead with pricing.', 'user'))
    addComment(db, id, 'On it.', 'agent', 'coder')
    expect(unreadIds()).toEqual([id])
  })

  it('acting on a task reads it, or their own move would come back as news', () => {
    const id = readTask()
    // A run failed while they were away: unread, and in Needs you.
    updateStatus(db, id, 'blocked')
    expect(unreadIds()).toEqual([id])
    // Dismissed from the card, without opening it.
    runOwnWrite(db, LOCAL_READER, id, () => updateStatus(db, id, 'cancelled', { actor: 'person' }))
    expect(unreadIds()).toEqual([])
  })

  it('an action that changed nothing reads nothing', () => {
    const id = readTask()
    updateStatus(db, id, 'blocked')
    expect(unreadIds()).toEqual([id])
    const refused = runOwnWrite(db, LOCAL_READER, id, () => updateStatus(db, id, 'done'))
    expect(refused.ok).toBe(false)
    expect(unreadIds()).toEqual([id])
  })

  it('an agent’s comment landing just after the action is still news', () => {
    const id = readTask()
    updateStatus(db, id, 'blocked')
    runOwnWrite(db, LOCAL_READER, id, () => updateStatus(db, id, 'todo', { actor: 'person' }))
    addComment(db, id, 'Picking it up again.', 'agent', 'coder')
    expect(unreadIds()).toEqual([id])
  })

  it('with no reader (not a person) the write counts as someone else’s', () => {
    const id = readTask()
    runOwnWrite(db, null, id, () => addComment(db, id, 'From a script.', 'agent'))
    expect(unreadIds()).toEqual([id])
  })

  it('a write that fails rolls back the mark with it', () => {
    const id = readTask()
    addComment(db, id, 'Unread before the failure.', 'agent', 'coder')
    expect(() =>
      runOwnWrite(db, LOCAL_READER, id, () => {
        addComment(db, id, 'Never saved.', 'user')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(unreadIds()).toEqual([id])
    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    expect(unreadIds()).toEqual([])
  })

  it('a write that says it made nothing new reads nothing', () => {
    const id = readTask()
    addComment(db, id, 'While the retry was on its way.', 'agent', 'coder')
    runOwnWrite(
      db,
      LOCAL_READER,
      () => null,
      () => 'found the task already there',
    )
    expect(unreadIds()).toEqual([id])
  })

  it('returns what the write returned', () => {
    const id = readTask()
    const comment = runOwnWrite(db, LOCAL_READER, id, () => addComment(db, id, 'Hello.', 'user'))
    expect(comment.body).toBe('Hello.')
  })

  it('one person’s write is unread for another, not for them', () => {
    const a = 'person:ann'
    const b = 'person:bo'
    const id = readTask()
    markTaskRead(db, a, id, seqOf(id))
    markTaskRead(db, b, id, seqOf(id))
    expect(unreadIds(a)).toEqual([])
    expect(unreadIds(b)).toEqual([])

    runOwnWrite(db, a, id, () => addComment(db, id, 'Ann here.', 'user'))
    expect(unreadIds(a)).toEqual([])
    expect(unreadIds(b)).toEqual([id])
    // Nor does it touch the built-in reader, who caught up before it.
    expect(unreadIds()).toEqual([id])
  })
})

describe('two rapid updates', () => {
  it('reading through the first keeps the second unread', () => {
    const id = readTask()
    addComment(db, id, 'First.', 'agent', 'coder')
    const sawFirst = seqOf(id)
    addComment(db, id, 'Second, after the drawer loaded.', 'agent', 'coder')
    markTaskRead(db, LOCAL_READER, id, sawFirst)
    expect(unreadIds()).toEqual([id])
  })

  it('two changes in the same millisecond stay two changes', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const id = readTask()
    addComment(db, id, 'First.', 'agent', 'coder')
    const sawFirst = seqOf(id)
    addComment(db, id, 'Second, same millisecond.', 'agent', 'coder')
    expect(seqOf(id)).toBeGreaterThan(sawFirst)
    markTaskRead(db, LOCAL_READER, id, sawFirst)
    expect(unreadIds()).toEqual([id])
  })

  it('a late mark never moves a reader back', () => {
    const id = readTask()
    addComment(db, id, 'First.', 'agent', 'coder')
    const first = seqOf(id)
    addComment(db, id, 'Second.', 'agent', 'coder')
    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    markTaskRead(db, LOCAL_READER, id, first)
    expect(unreadIds()).toEqual([])
  })

  it('a mark past the task’s newest change does not hide the next one', () => {
    const id = readTask()
    markTaskRead(db, LOCAL_READER, id, 1_000_000)
    addComment(db, id, 'Still news.', 'agent', 'coder')
    expect(unreadIds()).toEqual([id])
  })
})

describe('mark all read', () => {
  it('clears everything it saw and nothing after', () => {
    const one = createTask(db, { title: 'One', status: 'todo' })
    const two = createTask(db, { title: 'Two', status: 'todo' })
    expect(unreadIds().sort()).toEqual([one.id, two.id].sort())
    const through = boardActivityHead(db)
    const three = createTask(db, { title: 'Arrived while the page was up', status: 'todo' })
    markAllTasksRead(db, LOCAL_READER, through)
    expect(unreadIds()).toEqual([three.id])
  })

  it('can be limited to one team', () => {
    const now = Date.now()
    db.insert(teams)
      .values([
        { id: 'A', name: 'A', icon: 'a', color: '#000', createdAt: now, updatedAt: now },
        { id: 'B', name: 'B', icon: 'b', color: '#000', createdAt: now, updatedAt: now },
      ])
      .run()
    const inA = createTask(db, { title: 'In A', status: 'todo', teamId: 'A' })
    const inB = createTask(db, { title: 'In B', status: 'todo', teamId: 'B' })
    markAllTasksRead(db, LOCAL_READER, boardActivityHead(db), { teamId: 'A' })
    expect(unreadIds()).toEqual([inB.id])
    addComment(db, inA.id, 'New in A.', 'agent', 'coder')
    expect(unreadIds().sort()).toEqual([inA.id, inB.id].sort())
  })

  it('does not hide a later change even when asked to read past the newest', () => {
    const task = createTask(db, { title: 'One', status: 'todo' })
    markAllTasksRead(db, LOCAL_READER, 1_000_000)
    expect(unreadIds()).toEqual([])
    addComment(db, task.id, 'After.', 'agent', 'coder')
    expect(unreadIds()).toEqual([task.id])
  })
})

describe('what a read costs', () => {
  const baselineOf = (reader: string = LOCAL_READER): number =>
    db.select().from(taskReaders).where(eq(taskReaders.readerId, reader)).get()?.baselineSeq ?? 0

  it('opening tasks one at a time moves the baseline, so the list need not walk them again', () => {
    const ids = [readTask('One'), readTask('Two'), readTask('Three')]
    expect(baselineOf()).toBe(seqOf(ids[2]!))
    expect(unreadIds()).toEqual([])
  })

  it('stops just below the oldest task still unread, and changes no answer', () => {
    const stale = createTask(db, { title: 'Never opened', status: 'todo' })
    const a = readTask('A')
    const b = readTask('B')
    expect(baselineOf()).toBe(seqOf(stale.id) - 1)
    expect(stateOf(a)?.unread).toBe(false)
    expect(stateOf(b)?.unread).toBe(false)
    expect(unreadIds()).toEqual([stale.id])

    // Opening it lets the baseline catch up in one step.
    markTaskRead(db, LOCAL_READER, stale.id, seqOf(stale.id))
    expect(baselineOf()).toBe(seqOf(b))
    expect(unreadIds()).toEqual([])
  })

  it('a task read only part way holds the baseline below its unread change', () => {
    const id = readTask()
    addComment(db, id, 'First.', 'agent', 'coder')
    const first = seqOf(id)
    addComment(db, id, 'Second.', 'agent', 'coder')
    markTaskRead(db, LOCAL_READER, id, first)
    expect(baselineOf()).toBeLessThan(seqOf(id))
    expect(unreadIds()).toEqual([id])
  })

  it('caps the list at the newest, for a badge that stops counting at 99+', () => {
    const made = Array.from({ length: 5 }, (_, i) => createTask(db, { title: `T${i}` }).id)
    expect(unreadTasks(db, LOCAL_READER, { limit: 2 }).map((t) => t.id)).toEqual([made[4], made[3]])
    expect(unreadTasks(db, LOCAL_READER)).toHaveLength(5)
  })

  it('finds the tasks that need a person without reading the finished ones', () => {
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 't', color: '#000', createdAt: now, updatedAt: now })
      .run()
    const make = (status: TaskStatus, over: { sourceDelegationId?: string } = {}): string =>
      createTask(db, { title: status, status, teamId: 'T', ...over }).id
    const bound = { sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:lead' }
    for (const status of TASK_STATUSES) {
      make(status)
      make(status, bound)
    }
    const running = make('todo', bound)
    expect(claimTask(db, running, 'a1').ok).toBe(true)
    const dropped = make('blocked')
    dropTask(db, dropped)

    const everything = listTasks(db)
    const attention = attentionForTasks(db, everything)
    const expected = everything.filter((t) => attention.get(t.id)).map((t) => t.id)
    expect(expected.length).toBeGreaterThan(0)
    expect(taskIdsNeedingPerson(db).sort()).toEqual(expected.sort())
  })
})

describe('telling this person’s other browsers', () => {
  it('moves on every mark, even two in one millisecond, and not for someone else’s', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const id = createTask(db, { title: 'One', status: 'todo' }).id
    const other = createTask(db, { title: 'Two', status: 'todo' }).id
    expect(readerLastRead(db, LOCAL_READER)).toBe(0)

    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    const first = readerLastRead(db, LOCAL_READER)
    expect(first).toBeGreaterThan(0)

    markTaskRead(db, LOCAL_READER, other, seqOf(other))
    expect(readerLastRead(db, LOCAL_READER)).toBeGreaterThan(first)

    const before = readerLastRead(db, LOCAL_READER)
    markTaskRead(db, 'person:ann', id, seqOf(id))
    expect(readerLastRead(db, LOCAL_READER)).toBe(before)
  })

  it('moves when they act on a task and when they mark everything', () => {
    const id = readTask()
    const before = readerLastRead(db, LOCAL_READER)
    runOwnWrite(db, LOCAL_READER, id, () => addComment(db, id, 'Mine.', 'user'))
    const acted = readerLastRead(db, LOCAL_READER)
    expect(acted).toBeGreaterThan(before)
    markAllTasksRead(db, LOCAL_READER, boardActivityHead(db))
    expect(readerLastRead(db, LOCAL_READER)).toBeGreaterThan(acted)
  })
})

describe('where a reader starts', () => {
  it('goes by the stored baseline when another process set the reader up first', () => {
    // Its row landed between this read of the head and this insert, so the insert
    // conflicts. The change after that row's baseline must still show as news.
    const before = createTask(db, { title: 'Before', status: 'todo' })
    const after = createTask(db, { title: 'After', status: 'todo' })
    db.run(
      sql.raw(`CREATE TRIGGER other_process BEFORE INSERT ON task_readers
        WHEN NEW.reader_id = 'person:new'
          AND NOT EXISTS (SELECT 1 FROM task_readers WHERE reader_id = 'person:new')
        BEGIN
          INSERT INTO task_readers (reader_id, baseline_seq, updated_at)
          VALUES ('person:new', ${seqOf(before.id)}, 0);
        END`),
    )
    expect(unreadIds('person:new')).toEqual([after.id])
  })

  it('a new person behind a sign-in proxy starts caught up', () => {
    const task = createTask(db, { title: 'Before they arrived', status: 'todo' })
    expect(unreadIds('person:new')).toEqual([])
    expect(stateOf(task.id, 'person:new')?.unread).toBe(false)
    addComment(db, task.id, 'After they arrived.', 'agent', 'coder')
    expect(unreadIds('person:new')).toEqual([task.id])
  })

  it('a task changed before the triggers existed is not unread after an upgrade', () => {
    const file = path.join(dir, 'old.db')
    const old = createDb(file)
    const task = createTask(old, { title: 'From last month', status: 'done' })
    // The database as the last release left it.
    old.run(sql`DROP TRIGGER task_activity_created`)
    old.run(sql`DROP TRIGGER task_activity_changed`)
    old.run(sql`DROP TRIGGER task_activity_comment`)
    old.run(sql`DROP TABLE task_activity`)
    old.run(sql`DROP TABLE task_readers`)
    old.run(sql`DROP TABLE task_reads`)
    old.$client.close()

    const upgraded = openDb(file)
    ensureSchema(upgraded)
    expect(unreadTasks(upgraded, LOCAL_READER)).toEqual([])
    expect(taskReadStates(upgraded, LOCAL_READER).get(task.id)).toBeUndefined()
    addComment(upgraded, task.id, 'New since the upgrade.', 'agent', 'coder')
    expect(unreadTasks(upgraded, LOCAL_READER).map((t) => t.id)).toEqual([task.id])
    upgraded.$client.close()
  })
})

describe('survives', () => {
  it('a new connection to the same file', () => {
    const file = path.join(dir, 'test.db')
    const id = readTask()
    addComment(db, id, 'One.', 'agent', 'coder')
    addComment(db, id, 'Two.', 'agent', 'coder')
    markTaskRead(db, LOCAL_READER, id, seqOf(id))
    const other = createDb(file)
    expect(unreadTasks(other, LOCAL_READER)).toEqual([])
    // A write from another process counts too.
    addComment(other, id, 'From the stdio bin.', 'agent', 'coder')
    expect(unreadIds()).toEqual([id])
    other.$client.close()
  })
})
