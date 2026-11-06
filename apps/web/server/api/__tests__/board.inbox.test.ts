// A person's inbox over HTTP: read state per task on the server, so it follows the
// person from one browser to the next and through a restart. Unread means someone
// else changed or commented on the task since they last opened it. A person's own
// comment or move is not news to them; an agent's progress is.
//
// "A person" here is the dashboard's own page, or someone a sign-in proxy vouched
// for. Any other caller counts as someone else, and cannot mark anything read.

import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  addComment,
  agents,
  claimTask,
  createApproval,
  createTask,
  tasks,
  teams,
  updateStatus,
} from '@clawboo/db'
import express, { type Request, type Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: Array<{ teamId: string; taskId: string }> = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (teamId: string, taskId: string) => {
    dispatched.push({ teamId, taskId })
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const {
  boardAssignPOST,
  boardCommentPOST,
  boardCreatePOST,
  boardGetGET,
  boardListGET,
  boardRetryPOST,
  boardUpdatePATCH,
} = await import('../board')
const { boardInboxGET, boardInboxReadPOST, boardTaskReadPOST } = await import('../boardInbox')
const { resetReplyWakes } = await import('../../lib/teamChat/personReply')

const TEAM = 'T'
const AGENT = 'coder'

/** The fetch metadata a browser stamps on the dashboard page's own fetch(). */
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const SCRIPT: Record<string, string> = {}

interface Row {
  id: string
  unread: boolean
  activity: { seq: number; kind: string; at: number } | null
  [k: string]: unknown
}
interface Inbox {
  unread: Array<{ id: string; seq: number }>
  needsYou: string[]
  approvals: string[]
  through: number
}

type Person = { id: string; name: string | null; role: string | null }

async function call(
  handler: (req: Request, res: Response) => unknown,
  opts: {
    params?: Record<string, string>
    body?: unknown
    query?: Record<string, unknown>
    headers?: Record<string, string>
    person?: Person
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 200
  let body: Record<string, unknown> = {}
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: Record<string, unknown>) {
      body = b
      return this
    },
  } as unknown as Response
  await handler(
    {
      params: opts.params ?? {},
      body: opts.body,
      query: opts.query ?? {},
      headers: opts.headers ?? DASHBOARD,
      socket: {},
      get: () => undefined,
      protocol: 'http',
      person: opts.person,
    } as unknown as Request,
    res,
  )
  return { status, body }
}

async function board(person?: Person): Promise<Row[]> {
  const r = await call(boardListGET, { ...(person ? { person } : {}) })
  expect(r.status).toBe(200)
  return r.body['tasks'] as Row[]
}
async function row(id: string, person?: Person): Promise<Row> {
  const found = (await board(person)).find((t) => t.id === id)
  expect(found).toBeDefined()
  return found!
}
async function unreadIds(person?: Person): Promise<string[]> {
  const r = await call(boardInboxGET, { ...(person ? { person } : {}) })
  expect(r.status).toBe(200)
  return (r.body as unknown as Inbox).unread.map((t) => t.id)
}

/** The drawer's open: read the task, then mark what it showed. */
async function open(id: string, person?: Person): Promise<void> {
  const r = await call(boardGetGET, { params: { taskId: id }, ...(person ? { person } : {}) })
  const task = r.body['task'] as Row
  const marked = await call(boardTaskReadPOST, {
    params: { taskId: id },
    body: { through: task.activity?.seq ?? 0 },
    ...(person ? { person } : {}),
  })
  expect(marked.status).toBe(200)
}

async function agentTask(title = 'Write the post'): Promise<string> {
  const db = getDb()
  const r = await call(boardCreatePOST, {
    body: { title, teamId: TEAM, status: 'backlog' },
    headers: SCRIPT,
  })
  const id = (r.body['task'] as Row).id
  expect(updateStatus(db, id, 'todo').ok).toBe(true)
  return id
}
const agentComment = (id: string, body = 'Halfway there.'): void => {
  addComment(getDb(), id, body, 'agent', AGENT)
}

describe('a person’s inbox', () => {
  let home: string
  let prev: Record<string, string | undefined>

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-inbox-'))
    prev = { HOME: process.env['HOME'], CLAWBOO_HOME: process.env['CLAWBOO_HOME'] }
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    dispatched.length = 0
    resetReplyWakes()
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'T', icon: 't', color: '#fff', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: AGENT,
        name: 'Coder',
        gatewayId: AGENT,
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  describe('the read state', () => {
    it('clears on open and returns on a new comment from someone else', async () => {
      const id = await agentTask()
      expect(await unreadIds()).toEqual([id])
      expect((await row(id)).unread).toBe(true)

      await open(id)
      expect(await unreadIds()).toEqual([])
      expect((await row(id)).unread).toBe(false)

      agentComment(id)
      expect(await unreadIds()).toEqual([id])
      const after = await row(id)
      expect(after.unread).toBe(true)
      expect(after.activity?.kind).toBe('comment')
    })

    it('rides on one task’s read as well as on the list', async () => {
      const id = await agentTask()
      const before = await call(boardGetGET, { params: { taskId: id } })
      expect(before.body['task']).toMatchObject({ unread: true, activity: { kind: 'status' } })
      await open(id)
      const after = await call(boardGetGET, { params: { taskId: id } })
      expect(after.body['task']).toMatchObject({ unread: false })
    })

    it('reading the task does not mark it read, so an agent’s read changes nothing', async () => {
      const id = await agentTask()
      await call(boardGetGET, { params: { taskId: id }, headers: SCRIPT })
      await call(boardGetGET, { params: { taskId: id } })
      expect(await unreadIds()).toEqual([id])
    })

    it('survives a reload and a different browser', async () => {
      const id = await agentTask()
      const other = await agentTask('Another')
      await open(id)
      // A restart: nothing in memory survives. A second browser brings no state.
      resetDb()
      expect(await unreadIds()).toEqual([other])
      expect((await row(id)).unread).toBe(false)
      expect((await row(other)).unread).toBe(true)
    })

    it('keeps the second of two rapid updates when the page read only the first', async () => {
      const id = await agentTask()
      await open(id)
      agentComment(id, 'First.')
      const shown = (await row(id)).activity!.seq
      agentComment(id, 'Second, while the drawer was loading.')
      await call(boardTaskReadPOST, { params: { taskId: id }, body: { through: shown } })
      expect(await unreadIds()).toEqual([id])
    })

    it('a task nobody changed since the upgrade has no state and is not unread', async () => {
      const id = await agentTask()
      getDb().$client.prepare('DELETE FROM task_activity WHERE task_id = ?').run(id)
      const r = await row(id)
      expect(r.unread).toBe(false)
      expect(r.activity).toBeNull()
    })
  })

  describe('own writes', () => {
    it('a person’s own comment does not make it unread; the agent’s answer does', async () => {
      const id = await agentTask()
      await open(id)
      const r = await call(boardCommentPOST, {
        params: { taskId: id },
        body: { body: 'Lead with pricing.', authorType: 'user' },
      })
      expect(r.status).toBe(200)
      expect(await unreadIds()).toEqual([])

      agentComment(id, 'On it.')
      expect(await unreadIds()).toEqual([id])
    })

    it('a comment from anyone but the dashboard’s page is someone else’s', async () => {
      const id = await agentTask()
      await open(id)
      await call(boardCommentPOST, {
        params: { taskId: id },
        body: { body: 'From a script.', authorType: 'user' },
        headers: SCRIPT,
      })
      expect(await unreadIds()).toEqual([id])
    })

    it('a person’s own move does not make it unread', async () => {
      const id = await agentTask()
      await open(id)
      const r = await call(boardUpdatePATCH, {
        params: { taskId: id },
        body: { status: 'blocked' },
      })
      expect(r.status).toBe(200)
      expect(await unreadIds()).toEqual([])
    })

    it('a move from anyone but the dashboard’s page is someone else’s', async () => {
      const id = await agentTask()
      await open(id)
      await call(boardUpdatePATCH, {
        params: { taskId: id },
        body: { status: 'blocked' },
        headers: SCRIPT,
      })
      expect(await unreadIds()).toEqual([id])
    })

    it('a person’s own edit does not make it unread', async () => {
      const id = await agentTask()
      await open(id)
      await call(boardUpdatePATCH, { params: { taskId: id }, body: { title: 'Better title' } })
      expect(await unreadIds()).toEqual([])
    })

    it('a person’s new task is not unread for them', async () => {
      const r = await call(boardCreatePOST, { body: { title: 'Mine', teamId: TEAM } })
      expect(r.status).toBe(200)
      expect(await unreadIds()).toEqual([])
    })

    it('a person’s Retry and Assign are not unread; the run they start is', async () => {
      const db = getDb()
      const bound = await call(boardCreatePOST, {
        body: { title: 'Bound', teamId: TEAM, assigneeAgentId: AGENT },
      })
      const id = (bound.body['task'] as Row).id
      expect(await unreadIds()).toEqual([])

      const blocked = await call(boardUpdatePATCH, {
        params: { taskId: id },
        body: { status: 'blocked' },
      })
      expect(blocked.status).toBe(200)
      expect((await call(boardRetryPOST, { params: { taskId: id } })).status).toBe(202)
      expect(await unreadIds()).toEqual([])

      await call(boardUpdatePATCH, { params: { taskId: id }, body: { status: 'blocked' } })
      const assigned = await call(boardAssignPOST, {
        params: { taskId: id },
        body: { agentId: AGENT },
      })
      expect(assigned.status).toBe(200)
      expect(await unreadIds()).toEqual([])

      expect(claimTask(db, id, AGENT).ok).toBe(true)
      expect(await unreadIds()).toEqual([id])
    })

    it('replying to a blocked task restarts it without making it unread', async () => {
      const db = getDb()
      const bound = await call(boardCreatePOST, {
        body: {
          title: 'Bound',
          teamId: TEAM,
          assigneeAgentId: AGENT,
        },
      })
      const id = (bound.body['task'] as Row).id
      expect(updateStatus(db, id, 'blocked').ok).toBe(true)
      await open(id)

      const r = await call(boardCommentPOST, {
        params: { taskId: id },
        body: { body: 'Use the staging key.', authorType: 'user' },
      })
      expect(r.body['delivery']).toMatchObject({ status: 'woke-agent' })
      expect(await unreadIds()).toEqual([])
    })

    /** A run failed while the person was away: unread and in Needs you, counted once. */
    async function failedWhileAway(): Promise<string> {
      const bound = await call(boardCreatePOST, {
        body: { title: 'Bound', teamId: TEAM, assigneeAgentId: AGENT },
      })
      const id = (bound.body['task'] as Row).id
      expect(updateStatus(getDb(), id, 'blocked').ok).toBe(true)
      expect(await unreadIds()).toEqual([id])
      return id
    }
    const inbox = async (): Promise<Inbox> => (await call(boardInboxGET)).body as unknown as Inbox

    it('Dismiss on a card it never opened clears both the card and the unread', async () => {
      const id = await failedWhileAway()
      expect((await inbox()).needsYou).toContain(id)

      const r = await call(boardUpdatePATCH, {
        params: { taskId: id },
        body: { status: 'cancelled' },
      })
      expect(r.status).toBe(200)
      const after = await inbox()
      expect(after.unread).toEqual([])
      expect(after.needsYou).toEqual([])
    })

    it('Retry on a card it never opened reads it', async () => {
      const id = await failedWhileAway()
      expect((await call(boardRetryPOST, { params: { taskId: id } })).status).toBe(202)
      expect(await unreadIds()).toEqual([])
    })

    it('Assign on a card it never opened reads it', async () => {
      const id = await failedWhileAway()
      const r = await call(boardAssignPOST, { params: { taskId: id }, body: { agentId: AGENT } })
      expect(r.status).toBe(200)
      expect(await unreadIds()).toEqual([])
    })

    it('dragging a card it never opened reads it, and the next agent comment is news', async () => {
      const id = await agentTask()
      await open(id)
      agentComment(id, 'I have a question.')
      await call(boardUpdatePATCH, { params: { taskId: id }, body: { status: 'blocked' } })
      expect(await unreadIds()).toEqual([])

      agentComment(id, 'Still here.')
      expect(await unreadIds()).toEqual([id])
    })

    it('a move the board refused reads nothing', async () => {
      const id = await failedWhileAway()
      const refused = await call(boardUpdatePATCH, {
        params: { taskId: id },
        body: { status: 'done' },
      })
      expect(refused.status).toBe(409)
      expect(await unreadIds()).toEqual([id])
    })
  })

  describe('marking', () => {
    it('only a person can mark read', async () => {
      const id = await agentTask()
      const r = await call(boardTaskReadPOST, {
        params: { taskId: id },
        body: { through: 1_000 },
        headers: SCRIPT,
      })
      expect(r.status).toBe(403)
      const all = await call(boardInboxReadPOST, { body: { through: 1_000 }, headers: SCRIPT })
      expect(all.status).toBe(403)
      expect(await unreadIds()).toEqual([id])
    })

    it('someone a sign-in proxy vouched for is a person without the page’s headers', async () => {
      const ada: Person = { id: 'ada', name: 'Ada', role: null }
      const id = await agentTask()
      await unreadIds(ada)
      agentComment(id)
      expect(await unreadIds(ada)).toEqual([id])
      const r = await call(boardTaskReadPOST, {
        params: { taskId: id },
        body: { through: (await row(id, ada)).activity!.seq },
        headers: SCRIPT,
        person: ada,
      })
      expect(r.status).toBe(200)
      expect(await unreadIds(ada)).toEqual([])
    })

    it('refuses a bad body and an unknown task', async () => {
      const id = await agentTask()
      for (const body of [{}, { through: -1 }, { through: 'all' }, { through: 1.5 }]) {
        const r = await call(boardTaskReadPOST, { params: { taskId: id }, body })
        expect(r.status).toBe(400)
      }
      const missing = await call(boardTaskReadPOST, {
        params: { taskId: 'nope' },
        body: { through: 1 },
      })
      expect(missing.status).toBe(404)
      expect((await call(boardInboxReadPOST, { body: {} })).status).toBe(400)
    })

    it('marks everything read through what the page knew of', async () => {
      const one = await agentTask('One')
      const two = await agentTask('Two')
      expect((await unreadIds()).sort()).toEqual([one, two].sort())
      const seen = (await call(boardInboxGET)).body as unknown as Inbox

      const late = await agentTask('Arrived while the page was up')
      const r = await call(boardInboxReadPOST, { body: { through: seen.through } })
      expect(r.status).toBe(200)
      expect(await unreadIds()).toEqual([late])
    })

    it('can mark one team’s tasks read and leave the rest', async () => {
      const db = getDb()
      const now = Date.now()
      db.insert(teams)
        .values({ id: 'U', name: 'U', icon: 'u', color: '#fff', createdAt: now, updatedAt: now })
        .run()
      const mine = await agentTask('In T')
      const r = await call(boardCreatePOST, {
        body: { title: 'In U', teamId: 'U' },
        headers: SCRIPT,
      })
      const theirs = (r.body['task'] as Row).id
      expect((await unreadIds()).sort()).toEqual([mine, theirs].sort())

      const { through } = (await call(boardInboxGET)).body as unknown as Inbox
      await call(boardInboxReadPOST, { body: { through, teamId: TEAM } })
      expect(await unreadIds()).toEqual([theirs])
    })
  })

  describe('several people behind a sign-in proxy', () => {
    const ann: Person = { id: 'ann', name: 'Ann', role: null }
    const bo: Person = { id: 'bo', name: 'Bo', role: null }

    it('keeps each person’s reads apart', async () => {
      const id = await agentTask()
      await unreadIds(ann)
      await unreadIds(bo)
      agentComment(id)
      expect(await unreadIds(ann)).toEqual([id])
      expect(await unreadIds(bo)).toEqual([id])
      await open(id, ann)
      expect(await unreadIds(ann)).toEqual([])
      expect(await unreadIds(bo)).toEqual([id])
    })

    it('one person’s comment is unread for the other, not for them', async () => {
      const id = await agentTask()
      await unreadIds(ann)
      await unreadIds(bo)
      await call(boardCommentPOST, {
        params: { taskId: id },
        body: { body: 'Ann here.', authorType: 'user' },
        person: ann,
      })
      expect(await unreadIds(ann)).toEqual([])
      expect(await unreadIds(bo)).toEqual([id])
    })

    it('a new person starts caught up', async () => {
      await agentTask('From before they joined')
      expect(await unreadIds({ id: 'new', name: null, role: null })).toEqual([])
    })
  })

  describe('the inbox read', () => {
    it('lists what needs the person, approvals included, for the badge', async () => {
      const db = getDb()
      const stuck = await agentTask('Nobody bound to this')
      await open(stuck)
      const failing = await call(boardCreatePOST, {
        body: {
          title: 'Blocked by an agent',
          teamId: TEAM,
          status: 'todo',
          assigneeAgentId: AGENT,
        },
      })
      const blockedId = (failing.body['task'] as Row).id
      expect(updateStatus(db, blockedId, 'blocked').ok).toBe(true)
      const waiting = createApproval(db, { toolName: 'send_email', agentId: AGENT, args: {} })

      const inbox = (await call(boardInboxGET)).body as unknown as Inbox
      expect(inbox.needsYou.sort()).toEqual([stuck, blockedId].sort())
      expect(inbox.approvals).toEqual([waiting.id])
      expect(inbox.unread.map((t) => t.id)).toEqual([blockedId])
      expect(inbox.through).toBeGreaterThanOrEqual(inbox.unread[0]!.seq)
    })

    it('caps its lists for a badge that stops at 99+, the newest changes first', async () => {
      const db = getDb()
      let newest = ''
      for (let i = 0; i < 105; i++) {
        newest = createTask(db, { title: `T${i}`, teamId: TEAM, status: 'todo' }).id
      }
      const inbox = (await call(boardInboxGET)).body as unknown as Inbox
      expect(inbox.unread).toHaveLength(100)
      expect(inbox.unread[0]!.id).toBe(newest)
      expect(inbox.needsYou).toHaveLength(100)
      expect(inbox.through).toBe(inbox.unread[0]!.seq)
    })

    it('leaves finished work out of what needs a person', async () => {
      const db = getDb()
      const done = createTask(db, { title: 'Finished', teamId: TEAM, status: 'done' }).id
      const inbox = (await call(boardInboxGET)).body as unknown as Inbox
      expect(inbox.needsYou).not.toContain(done)
    })
  })

  describe('the event tail', () => {
    /** Read the stream's frames until `done`, or fail after a few seconds. */
    async function readFrames(
      url: string,
      done: (frames: Array<{ event: string; data: string; id?: string }>) => boolean,
      onOpen?: () => void,
      ms = 5_000,
    ): Promise<Array<{ event: string; data: string; id?: string }>> {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), ms)
      const frames: Array<{ event: string; data: string; id?: string }> = []
      try {
        const res = await fetch(url, { signal: abort.signal })
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let opened = false
        for (;;) {
          const { value, done: ended } = await reader.read()
          if (ended) return frames
          buf += decoder.decode(value, { stream: true })
          let cut: number
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            if (!opened && block.startsWith(':')) {
              opened = true
              onOpen?.()
              continue
            }
            if (block.startsWith(':')) continue
            const frame: { event: string; data: string; id?: string } = {
              event: 'message',
              data: '',
            }
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) frame.event = line.slice(7)
              if (line.startsWith('data: ')) frame.data = line.slice(6)
              if (line.startsWith('id: ')) frame.id = line.slice(4)
            }
            frames.push(frame)
            if (done(frames)) return frames
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return frames
        throw err
      } finally {
        clearTimeout(timer)
        abort.abort()
      }
    }

    async function withServer(run: (base: string) => Promise<void>): Promise<void> {
      const { apiRouter } = await import('../index')
      const app = express()
      app.use(express.json())
      app.use(apiRouter)
      const server = http.createServer(app)
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      } finally {
        server.closeAllConnections()
        await new Promise((r) => server.close(r))
      }
    }

    it('says where the board is on connecting, and again when any write changes it', async () => {
      const id = await agentTask()
      const head = (await row(id)).activity!.seq
      await withServer(async (base) => {
        const activity = (f: { event: string }): boolean => f.event === 'activity'
        const frames = await readFrames(
          `${base}/api/obs/stream?activity=1`,
          (all) => all.filter(activity).length >= 2,
          // A comment no event row is written for: an agent's task tool writes the
          // row directly, so nothing but the board's own record says it happened.
          () => agentComment(id),
        )
        const seqs = frames.filter(activity).map((f) => (JSON.parse(f.data) as { seq: number }).seq)
        expect(seqs[0]).toBeGreaterThanOrEqual(head)
        expect(seqs[seqs.length - 1]).toBeGreaterThan(head)
        // It never moves the resume cursor.
        for (const f of frames.filter(activity)) expect(f.id).toBeUndefined()
      })
    })

    it('says when this person read something, so their other browsers catch up', async () => {
      const id = await agentTask()
      const seq = (await row(id)).activity!.seq
      await withServer(async (base) => {
        const activity = (f: { event: string }): boolean => f.event === 'activity'
        const frames = await readFrames(
          `${base}/api/obs/stream?activity=1`,
          (all) => all.filter(activity).length >= 2,
          () => void call(boardTaskReadPOST, { params: { taskId: id }, body: { through: seq } }),
        )
        const reads = frames
          .filter(activity)
          .map((f) => (JSON.parse(f.data) as { read: number }).read)
        expect(reads[reads.length - 1]).toBeGreaterThan(reads[0]!)
      })
    })

    it('stays silent when someone else reads', async () => {
      const ann: Person = { id: 'ann', name: 'Ann', role: null }
      const id = await agentTask()
      await unreadIds(ann)
      const seq = (await row(id)).activity!.seq
      await withServer(async (base) => {
        const frames = await readFrames(
          `${base}/api/obs/stream?activity=1`,
          () => false,
          () =>
            void call(boardTaskReadPOST, {
              params: { taskId: id },
              body: { through: seq },
              person: ann,
            }),
          2_000,
        )
        expect(frames.filter((f) => f.event === 'activity')).toHaveLength(1)
      })
    }, 10_000)

    it('stays silent while nothing changes', async () => {
      await agentTask()
      await withServer(async (base) => {
        const frames = await readFrames(
          `${base}/api/obs/stream?activity=1`,
          () => false,
          undefined,
          2_000,
        )
        expect(frames.filter((f) => f.event === 'activity')).toHaveLength(1)
      })
    }, 10_000)

    it('sends none to a client that did not ask, so the stream stays as it was', async () => {
      await agentTask()
      await withServer(async (base) => {
        const frames = await readFrames(
          `${base}/api/obs/stream`,
          () => false,
          () => {
            agentComment(getDb().select().from(tasks).get()!.id)
          },
          2_000,
        )
        expect(frames.filter((f) => f.event === 'activity')).toEqual([])
      })
    }, 10_000)
  })

  describe('over real HTTP', () => {
    it('serves /api/board/inbox rather than treating it as a task id', async () => {
      const { apiRouter } = await import('../index')
      const app = express()
      app.use(express.json())
      app.use(apiRouter)
      const server = http.createServer(app)
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      try {
        const port = (server.address() as AddressInfo).port
        const res = await fetch(`http://127.0.0.1:${port}/api/board/inbox`)
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ unread: [], needsYou: [], approvals: [] })
      } finally {
        await new Promise((r) => server.close(r))
      }
    })
  })
})
