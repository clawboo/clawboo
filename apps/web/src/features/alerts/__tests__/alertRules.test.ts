// The rules behind the browser alerts: what is announced, what is new, what an
// alert says and where its click goes, and how the watcher turns a burst of
// events into one read and one alert.

import { describe, expect, it, vi } from 'vitest'

import {
  alertNotice,
  approvalAsk,
  collectAlertItems,
  createAlertWatcher,
  foldAlertRead,
  latestAlertTrigger,
  latestInboxTrigger,
  startAlertMemory,
  type AlertAgent,
  type AlertApprovalInput,
  type AlertNotice,
  type AlertRead,
  type AlertTaskInput,
} from '../alertRules'

const task = (
  id: string,
  reason: string | null,
  extra: Partial<AlertTaskInput> = {},
): AlertTaskInput => ({
  id,
  title: `Task ${id}`,
  status: reason ? 'blocked' : 'in_progress',
  teamId: 'team-a',
  attention: reason ? { reason, failedRuns: 1 } : null,
  updatedAt: 1000,
  ...extra,
})

const approval = (id: string, extra: Partial<AlertApprovalInput> = {}): AlertApprovalInput => ({
  id,
  toolName: 'mcp__github__create_issue',
  agentId: 'ada',
  kind: 'tool',
  createdAt: 1000,
  expiresAt: null,
  ...extra,
})

const AGENTS: Record<string, AlertAgent> = {
  ada: { name: 'Ada', teamId: 'team-a' },
  zed: { name: 'Zed', teamId: 'team-b' },
  solo: { name: 'Solo', teamId: null },
}
const agentOf = (id: string | null): AlertAgent | null => (id ? (AGENTS[id] ?? null) : null)

describe('collectAlertItems', () => {
  it('announces runs that broke, blocked tasks and failed checks, nothing a person caused', () => {
    const items = collectAlertItems(
      [
        task('f', 'failed'),
        task('t', 'timed_out'),
        task('b', 'blocked'),
        task('r', 'needs_review'),
        task('s', 'stopped', { status: 'todo' }),
        task('u', 'unassigned', { status: 'todo' }),
        task('n', 'unstarted'),
        task('ok', null),
      ],
      [],
    )
    expect(items.map((i) => i.key)).toEqual([
      'task:f:failed:1',
      'task:t:timed_out:1',
      'task:b:blocked:1',
      'task:r:needs_review:1',
    ])
  })

  it("leaves out a Blocked move the server says was the person's own, whatever changed since", () => {
    const items = collectAlertItems(
      [
        // The server compares the move with the latest run start, so a later
        // edit to the title (a newer updatedAt) does not undo it.
        task('mine', null, {
          status: 'blocked',
          attention: { reason: 'blocked', failedRuns: 0, byPerson: true },
          updatedAt: 9000,
        }),
        task('agent', 'blocked'),
      ],
      [],
    )
    expect(items.map((i) => i.key)).toEqual(['task:agent:blocked:1'])
  })

  it.each([
    ['no_result', 'finished with no result'],
    ['rate_limited', 'is rate limited by its provider'],
    ['provider_down', 'could not reach its provider'],
    ['out_of_room', 'ran out of room'],
    ['budget', 'was stopped by a budget cap'],
    ['breaker', 'was stopped by the circuit breaker'],
  ] as const)('announces a task that ended as %s', (reason, words) => {
    const [item] = collectAlertItems([task('t1', reason)], [])
    expect(alertNotice([item!], agentOf)?.body).toContain(words)
  })

  it('records when each item began waiting', () => {
    const [a, t] = collectAlertItems([task('f', 'failed', { updatedAt: 4000 })], [approval('a1')])
    expect(a).toMatchObject({ kind: 'approval', at: 1000 })
    expect(t).toMatchObject({ kind: 'task', at: 4000 })
  })

  it('reads a blocked task from a server too old to send attention', () => {
    const items = collectAlertItems([{ id: 'old', status: 'blocked', title: 'Old' }], [])
    expect(items).toMatchObject([{ kind: 'task', reason: 'blocked', title: 'Old' }])
  })

  it('lists each pending approval once and skips one that has run out', () => {
    const now = 10_000
    const items = collectAlertItems(
      [],
      [
        approval('a1'),
        approval('a1', { kind: 'exec', toolName: 'exec' }),
        approval('gone', { expiresAt: now - 1 }),
      ],
      now,
    )
    expect(items.map((i) => i.key)).toEqual(['approval:a1'])
  })
})

describe('foldAlertRead', () => {
  const SINCE = 5000
  const read = (over: Partial<AlertRead> = {}): AlertRead => ({
    tasks: [],
    approvals: [],
    approvalsComplete: true,
    ...over,
  })
  const keys = (items: { key: string }[]) => items.map((i) => i.key)

  it('takes what is waiting as seen, and announces what comes after', () => {
    let m = startAlertMemory(SINCE)
    m = foldAlertRead(m, read({ tasks: [task('old', 'failed')] }), { announce: false }).memory
    const next = foldAlertRead(
      m,
      read({ tasks: [task('old', 'failed'), task('new', 'failed', { updatedAt: 6000 })] }),
      { announce: true },
    )
    expect(keys(next.fresh)).toEqual(['task:new:failed:1'])
    expect(
      foldAlertRead(next.memory, read({ tasks: [task('old', 'failed')] }), { announce: true })
        .fresh,
    ).toEqual([])
  })

  it('announces a task that fails again, even when no read saw it leave the list', () => {
    let m = startAlertMemory(SINCE)
    m = foldAlertRead(m, read({ tasks: [task('f', 'failed')] }), { announce: false }).memory
    const again = task('f', null, {
      status: 'blocked',
      attention: { reason: 'failed', failedRuns: 2 },
      updatedAt: 7000,
    })
    expect(keys(foldAlertRead(m, read({ tasks: [again] }), { announce: true }).fresh)).toEqual([
      'task:f:failed:2',
    ])
  })

  it('announces what began waiting after the tab left, even when the first read already held it', () => {
    // The task failed between the tab leaving and the server answering.
    const m = foldAlertRead(
      startAlertMemory(SINCE),
      read({ tasks: [task('old', 'failed'), task('raced', 'failed', { updatedAt: 5200 })] }),
      { announce: false },
    ).memory
    expect(
      keys(
        foldAlertRead(
          m,
          read({ tasks: [task('old', 'failed'), task('raced', 'failed', { updatedAt: 5200 })] }),
          { announce: true },
        ).fresh,
      ),
    ).toEqual(['task:raced:failed:1'])
  })

  it('goes by when each item began waiting when the first read failed', () => {
    const m = foldAlertRead(
      startAlertMemory(SINCE),
      read({ tasks: null, approvals: [], approvalsComplete: false }),
      { announce: false },
    ).memory
    const after = foldAlertRead(
      m,
      read({
        tasks: [
          task('before', 'failed', { updatedAt: 4000 }),
          task('after', 'failed', { updatedAt: 6000 }),
        ],
        approvals: [approval('a-old', { createdAt: 4500 }), approval('a-new', { createdAt: 5500 })],
      }),
      { announce: true },
    )
    expect(keys(after.fresh).sort()).toEqual(['approval:a-new', 'task:after:failed:1'])
    // And from then on the lists are known, so anything new counts.
    expect(
      keys(
        foldAlertRead(
          after.memory,
          read({
            tasks: [
              task('before', 'failed', { updatedAt: 4000 }),
              task('late', 'failed', { updatedAt: 1 }),
            ],
          }),
          { announce: true },
        ).fresh,
      ),
    ).toEqual(['task:late:failed:1'])
  })

  it('still announces approvals when the board cannot be read, and keeps what it knew of tasks', () => {
    let m = startAlertMemory(SINCE)
    m = foldAlertRead(m, read({ tasks: [task('old', 'failed')] }), { announce: false }).memory
    const noBoard = foldAlertRead(
      m,
      read({ tasks: null, approvals: [approval('a1', { createdAt: 6000 })] }),
      { announce: true },
    )
    expect(keys(noBoard.fresh)).toEqual(['approval:a1'])
    // The board is back: the old task is still known, nothing is said twice.
    expect(
      foldAlertRead(
        noBoard.memory,
        read({ tasks: [task('old', 'failed')], approvals: [approval('a1', { createdAt: 6000 })] }),
        { announce: true },
      ).fresh,
    ).toEqual([])
  })

  it('announces a Gateway approval when the queue cannot be read, without forgetting the queue', () => {
    let m = startAlertMemory(SINCE)
    m = foldAlertRead(m, read({ approvals: [approval('queued')] }), { announce: false }).memory
    const partial = foldAlertRead(
      m,
      read({
        approvals: [approval('shell', { kind: 'exec', toolName: 'exec', createdAt: 6000 })],
        approvalsComplete: false,
      }),
      { announce: true },
    )
    expect(keys(partial.fresh)).toEqual(['approval:shell'])
    // The queue is back, still holding the old one: not news.
    expect(
      foldAlertRead(
        partial.memory,
        read({ approvals: [approval('queued'), approval('shell', { kind: 'exec' })] }),
        { announce: true },
      ).fresh,
    ).toEqual([])
  })

  it('forgets what left a whole list, so its return is news again', () => {
    let m = startAlertMemory(SINCE)
    m = foldAlertRead(m, read({ tasks: [task('b', 'blocked')] }), { announce: false }).memory
    m = foldAlertRead(m, read({ tasks: [] }), { announce: true }).memory
    expect(
      keys(
        foldAlertRead(m, read({ tasks: [task('b', 'blocked', { updatedAt: 8000 })] }), {
          announce: true,
        }).fresh,
      ),
    ).toEqual(['task:b:blocked:1'])
  })
})

describe('alertNotice', () => {
  it('says what happened to one task and opens it', () => {
    const [item] = collectAlertItems([task('f', 'timed_out', { title: 'Send the invoice' })], [])
    expect(alertNotice([item!], agentOf)).toMatchObject({
      title: 'A task needs you',
      body: '"Send the invoice" stopped responding. Click to open it.',
      target: { kind: 'task', taskId: 'f', teamId: 'team-a' },
    })
  })

  it('names the agent waiting on one approval and opens Needs you on its team', () => {
    const items = collectAlertItems([], [approval('a1', { agentId: 'zed' })])
    expect(alertNotice(items, agentOf)).toMatchObject({
      title: 'Zed needs your approval',
      body: 'It wants to use create issue. Click to allow or deny.',
      target: { kind: 'needs-you', teamId: 'team-b' },
    })
  })

  it('shows every team for an agent outside one, and keeps the team for an unknown caller', () => {
    const solo = collectAlertItems([], [approval('a1', { agentId: 'solo' })])
    expect(alertNotice(solo, agentOf)?.target).toEqual({ kind: 'needs-you', teamId: 'all' })
    const nobody = collectAlertItems([], [approval('a2', { agentId: null })])
    expect(alertNotice(nobody, agentOf)).toMatchObject({
      title: 'An agent needs your approval',
      target: { kind: 'needs-you', teamId: null },
    })
  })

  it('batches several into one, approvals first, with a count of the rest', () => {
    const items = collectAlertItems(
      [task('f', 'failed', { title: 'Fix the footer' }), task('b', 'blocked')],
      [approval('a1')],
    )
    const notice = alertNotice(items, agentOf)!
    expect(notice.title).toBe('3 things need you')
    expect(notice.body).toBe(
      'Ada wants to use create issue. "Fix the footer" failed. And 1 more. Click to see them under Needs you.',
    )
    expect(notice.target).toEqual({ kind: 'needs-you', teamId: 'team-a' })
  })

  it('counts tasks and approvals by name when they are all one kind, across teams', () => {
    const tasks = collectAlertItems(
      [task('f', 'failed'), task('g', 'failed', { teamId: 'team-b' })],
      [],
    )
    expect(alertNotice(tasks, agentOf)).toMatchObject({
      title: '2 tasks need you',
      target: { kind: 'needs-you', teamId: 'all' },
    })
    const approvals = collectAlertItems([], [approval('a1'), approval('a2')])
    expect(alertNotice(approvals, agentOf)?.title).toBe('2 approvals are waiting')
  })

  it('gives each batch its own tag, the same for the same batch', () => {
    const items = collectAlertItems([task('f', 'failed')], [approval('a1')])
    const a = alertNotice(items, agentOf)!
    const b = alertNotice([...items].reverse(), agentOf)!
    expect(a.tag).toBe(b.tag)
    expect(a.tag).not.toBe(alertNotice(items.slice(0, 1), agentOf)!.tag)
  })

  it('is null for nothing new', () => {
    expect(alertNotice([], agentOf)).toBeNull()
  })

  it('shortens a very long title', () => {
    const [item] = collectAlertItems([task('f', 'failed', { title: 'x'.repeat(200) })], [])
    expect(alertNotice([item!], agentOf)!.body.length).toBeLessThan(120)
  })
})

describe('approvalAsk', () => {
  it('says what the agent wants in plain words', () => {
    expect(approvalAsk('exec')).toBe('run a command')
    expect(approvalAsk('run_command')).toBe('run a command')
    expect(approvalAsk('delegate:code')).toBe('hand work to another agent')
    expect(approvalAsk('mcp__my_server__send_email')).toBe('use send email')
    expect(approvalAsk('web_search')).toBe('use web search')
  })
})

describe('latestInboxTrigger', () => {
  it('wakes for what changes the inbox: a run ending, a move, an approval opened or answered', () => {
    expect(
      latestInboxTrigger([
        { seq: 1, kind: 'execution_completed' },
        { seq: 4, kind: 'approval_resolved' },
        { seq: 9, kind: 'tool_call' },
        { seq: 7, kind: 'cost' },
      ]),
    ).toBe(4)
    expect(latestInboxTrigger([{ seq: 3, kind: 'tool_result' }])).toBe(0)
  })
})

describe('latestAlertTrigger', () => {
  it('is the newest run end, task move or approval, ignoring the chatter', () => {
    expect(
      latestAlertTrigger([
        { seq: 1, kind: 'execution_completed' },
        { seq: 4, kind: 'approval_requested' },
        { seq: 9, kind: 'tool_call' },
        { seq: 7, kind: 'cost' },
      ]),
    ).toBe(4)
    expect(latestAlertTrigger([{ seq: 3, kind: 'tool_result' }])).toBe(0)
  })
})

describe('createAlertWatcher', () => {
  const SINCE = 5000
  function harness() {
    let tasks: AlertTaskInput[] | null = []
    let approvals: AlertApprovalInput[] = []
    let approvalsComplete = true
    const notices: AlertNotice[] = []
    const reads = { count: 0, complete: [] as boolean[] }
    const watcher = createAlertWatcher({
      readTasks: async () => {
        reads.count += 1
        return tasks
      },
      readApprovals: async () => ({ rows: approvals, complete: approvalsComplete }),
      agentOf,
      notify: (n) => notices.push(n),
      onRead: (complete) => reads.complete.push(complete),
      now: () => 10_000,
    })
    return {
      watcher,
      notices,
      reads,
      set(t: AlertTaskInput[] | null, a: AlertApprovalInput[] = [], complete = true) {
        tasks = t
        approvals = a
        approvalsComplete = complete
      },
    }
  }

  it('announces only what arrived after the prime', async () => {
    const h = harness()
    h.set([task('old', 'failed')])
    await h.watcher.prime(SINCE)
    h.set([task('old', 'failed'), task('new', 'failed', { updatedAt: 6000 })])
    await h.watcher.check()
    expect(h.notices.map((n) => n.title)).toEqual(['A task needs you'])
    expect(h.notices[0]!.body).toContain('Task new')
    // Nothing changed: nothing more to say.
    await h.watcher.check()
    expect(h.notices).toHaveLength(1)
  })

  it('checks without a prime as if the tab had just left', async () => {
    const h = harness()
    h.set([task('a', 'failed')])
    await h.watcher.check()
    expect(h.notices).toEqual([])
  })

  it('announces what arrived after a failed prime, and not what was there before', async () => {
    const h = harness()
    h.set(null, [], false)
    await h.watcher.prime(SINCE)
    expect(h.reads.complete).toEqual([false])
    h.set([
      task('before', 'failed', { updatedAt: 4000 }),
      task('after', 'failed', { updatedAt: 6000 }),
    ])
    await h.watcher.check()
    expect(h.notices.map((n) => n.body)).toEqual(['"Task after" failed. Click to open it.'])
    expect(h.reads.complete).toEqual([false, true])
  })

  it('says when part of a read failed, so the caller can try again', async () => {
    const h = harness()
    await h.watcher.prime(SINCE)
    h.set([], [approval('a1', { createdAt: 6000 })], false)
    await h.watcher.check()
    expect(h.reads.complete).toEqual([true, false])
    expect(h.notices.map((n) => n.title)).toEqual(['Ada needs your approval'])
  })

  it('turns a burst of checks into one more read and one alert', async () => {
    const h = harness()
    await h.watcher.prime(SINCE)
    h.set([task('a', 'failed', { updatedAt: 6000 }), task('b', 'failed', { updatedAt: 6000 })])
    const runs = [h.watcher.check(), h.watcher.check(), h.watcher.check()]
    await Promise.all(runs)
    expect(h.reads.count).toBe(3) // the prime, the first check, one catch-up
    expect(h.notices.map((n) => n.title)).toEqual(['2 tasks need you'])
  })

  it('drops a read that was out when it was reset', async () => {
    let release: () => void = () => {}
    const notify = vi.fn()
    let tasks: AlertTaskInput[] = []
    const watcher = createAlertWatcher({
      readTasks: () =>
        new Promise((resolve) => {
          release = () => resolve(tasks)
        }),
      readApprovals: async () => ({ rows: [], complete: true }),
      agentOf,
      notify,
      now: () => 10_000,
    })
    const first = watcher.check()
    watcher.reset()
    // It began waiting after the read started, so only the reset keeps it quiet.
    tasks = [task('a', 'failed', { updatedAt: 12_000 })]
    release()
    await first
    expect(notify).not.toHaveBeenCalled()
  })
})
