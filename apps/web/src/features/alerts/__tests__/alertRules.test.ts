// The rules behind the browser alerts: what is announced, what is new, what an
// alert says and where its click goes, and how the watcher turns a burst of
// events into one read and one alert.

import { describe, expect, it, vi } from 'vitest'

import {
  alertNotice,
  approvalAsk,
  collectAlertItems,
  createAlertWatcher,
  diffAlertItems,
  latestAlertTrigger,
  type AlertAgent,
  type AlertApprovalInput,
  type AlertNotice,
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
  personMovedAt: null,
  ...extra,
})

const approval = (id: string, extra: Partial<AlertApprovalInput> = {}): AlertApprovalInput => ({
  id,
  toolName: 'mcp__github__create_issue',
  agentId: 'ada',
  kind: 'tool',
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
      'task:f:failed',
      'task:t:timed_out',
      'task:b:blocked',
      'task:r:needs_review',
    ])
  })

  it('leaves out a task the person moved to Blocked themselves', () => {
    const items = collectAlertItems(
      [
        task('mine', 'blocked', { updatedAt: 2000, personMovedAt: 2000 }),
        // A person moved it earlier, then an agent blocked it: that one is news.
        task('agent', 'blocked', { updatedAt: 3000, personMovedAt: 2000 }),
        // A person's move does not hide a run that failed after it.
        task('ran', 'failed', { updatedAt: 2000, personMovedAt: 2000 }),
      ],
      [],
    )
    expect(items.map((i) => i.key)).toEqual(['task:agent:blocked', 'task:ran:failed'])
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

describe('diffAlertItems', () => {
  it('returns only what is new, and forgets what left so its return is new again', () => {
    const first = collectAlertItems([task('f', 'failed')], [approval('a1')])
    const { fresh: none, seen } = diffAlertItems(first, new Set(first.map((i) => i.key)))
    expect(none).toEqual([])

    // The task was retried (left the list) while the approval stayed.
    const second = collectAlertItems([], [approval('a1')])
    const next = diffAlertItems(second, seen)
    expect(next.fresh).toEqual([])

    // It failed again: announced again.
    const third = diffAlertItems(
      collectAlertItems([task('f', 'failed')], [approval('a1')]),
      next.seen,
    )
    expect(third.fresh.map((i) => i.key)).toEqual(['task:f:failed'])
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
  function harness() {
    let tasks: AlertTaskInput[] = []
    let approvals: AlertApprovalInput[] = []
    let failRead = false
    const notices: AlertNotice[] = []
    const reads = { count: 0 }
    const watcher = createAlertWatcher({
      readTasks: async () => {
        reads.count += 1
        return failRead ? null : tasks
      },
      readApprovals: async () => approvals,
      agentOf,
      notify: (n) => notices.push(n),
    })
    return {
      watcher,
      notices,
      reads,
      set(t: AlertTaskInput[], a: AlertApprovalInput[] = []) {
        tasks = t
        approvals = a
      },
      failNext(v: boolean) {
        failRead = v
      },
    }
  }

  it('announces only what arrived after the prime', async () => {
    const h = harness()
    h.set([task('old', 'failed')])
    await h.watcher.prime()
    h.set([task('old', 'failed'), task('new', 'failed')])
    await h.watcher.check()
    expect(h.notices.map((n) => n.title)).toEqual(['A task needs you'])
    expect(h.notices[0]!.body).toContain('Task new')
    // Nothing changed: nothing more to say.
    await h.watcher.check()
    expect(h.notices).toHaveLength(1)
  })

  it('primes instead of announcing when asked to check first', async () => {
    const h = harness()
    h.set([task('a', 'failed')])
    await h.watcher.check()
    expect(h.notices).toEqual([])
  })

  it('keeps what it had seen when a read fails', async () => {
    const h = harness()
    h.set([task('a', 'failed')])
    await h.watcher.prime()
    h.failNext(true)
    await h.watcher.check()
    h.failNext(false)
    await h.watcher.check()
    expect(h.notices).toEqual([])
  })

  it('turns a burst of checks into one more read and one alert', async () => {
    const h = harness()
    await h.watcher.prime()
    h.set([task('a', 'failed'), task('b', 'failed')])
    const runs = [h.watcher.check(), h.watcher.check(), h.watcher.check()]
    await Promise.all(runs)
    expect(h.reads.count).toBe(3) // the prime, the first check, one catch-up
    expect(h.notices.map((n) => n.title)).toEqual(['2 tasks need you'])
  })

  it('drops a read that was out when it was reset, then primes again', async () => {
    let release: () => void = () => {}
    const notify = vi.fn()
    let tasks: AlertTaskInput[] = []
    const watcher = createAlertWatcher({
      readTasks: () =>
        new Promise((resolve) => {
          release = () => resolve(tasks)
        }),
      readApprovals: async () => [],
      agentOf,
      notify,
    })
    const first = watcher.prime()
    watcher.reset()
    tasks = [task('a', 'failed')]
    release()
    await first
    // The reset dropped the prime, so this check primes rather than announcing.
    const check = watcher.check()
    release()
    await check
    expect(notify).not.toHaveBeenCalled()
  })
})
