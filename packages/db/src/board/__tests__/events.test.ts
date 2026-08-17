import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import {
  enqueueInbox,
  listAgentsWithUndeliveredInbox,
  listUndeliveredInbox,
  markInboxDelivered,
  packInboxRows,
  renderInboxDigest,
  splitInboxByAddressing,
} from '../../inbox'
import { onBoardLifecycle, resetBoardLifecycleListeners, type BoardLifecycleEvent } from '../events'
import {
  addComment,
  claimTask,
  completeExecutionProcess,
  createCappedRootTask,
  createCappedSubtask,
  createExecutionProcess,
  createTask,
  reconcileStaleInProgress,
  releaseTask,
  updateStatus,
} from '../repository'

let db: ClawbooDb
let seen: BoardLifecycleEvent[]

beforeEach(() => {
  db = createDb(':memory:')
  seen = []
  onBoardLifecycle((ev) => seen.push(ev))
})
afterEach(() => resetBoardLifecycleListeners())

describe('board lifecycle bus', () => {
  it('every repository write path publishes exactly one post-commit event', () => {
    const t = createTask(db, {
      title: 'work',
      teamId: 'T',
      sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:leader',
    })
    expect(seen).toContainEqual({
      kind: 'task_created',
      taskId: t.id,
      teamId: 'T',
      sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:leader',
    })

    claimTask(db, t.id, 'a1')
    expect(seen).toContainEqual({
      kind: 'task_claimed',
      taskId: t.id,
      teamId: 'T',
      assigneeAgentId: 'a1',
    })

    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    completeExecutionProcess(db, ex.id, { status: 'succeeded', summary: 'done' })
    expect(seen).toContainEqual({
      kind: 'execution_completed',
      taskId: t.id,
      teamId: 'T',
      execId: ex.id,
      status: 'succeeded',
      executorType: 'codex',
    })
    // A second completion of the same (now terminal) exec must NOT re-publish.
    completeExecutionProcess(db, ex.id, { status: 'failed' })
    expect(seen.filter((e) => e.kind === 'execution_completed')).toHaveLength(1)

    addComment(db, t.id, 'report', 'agent', 'a1')
    expect(seen).toContainEqual({
      kind: 'comment_added',
      taskId: t.id,
      teamId: 'T',
      authorType: 'agent',
      authorAgentId: 'a1',
    })

    releaseTask(db, t.id)
    expect(seen).toContainEqual({
      kind: 'task_released',
      taskId: t.id,
      teamId: 'T',
      via: 'release',
    })
    // Releasing a task that is not in_progress publishes nothing.
    const before = seen.length
    releaseTask(db, t.id)
    expect(seen).toHaveLength(before)

    updateStatus(db, t.id, 'backlog')
    expect(seen).toContainEqual({
      kind: 'status_changed',
      taskId: t.id,
      teamId: 'T',
      status: 'backlog',
    })
  })

  it('the sweep publishes a task_released(sweep) per reclaimed task', () => {
    const t = createTask(db, { title: 'hung', teamId: 'T' })
    claimTask(db, t.id, 'a1')
    createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    seen = []
    reconcileStaleInProgress(db, -10_000)
    expect(seen).toContainEqual({
      kind: 'task_released',
      taskId: t.id,
      teamId: 'T',
      via: 'sweep',
    })
  })

  it('the CAPPED creates publish task_created too (they are the Tasks MCP create path)', () => {
    // These insert inside their own transaction instead of delegating to
    // createTask, so they publish for themselves. Without it a task an agent
    // creates over MCP is invisible to every subscriber, including the pump that
    // would fire it.
    const parent = createTask(db, { title: 'parent', teamId: 'T' })
    seen = []

    const root = createCappedRootTask(db, { title: 'mcp root', teamId: 'T' })
    expect(root.ok).toBe(true)
    expect(seen).toContainEqual({
      kind: 'task_created',
      taskId: root.ok ? root.task.id : '',
      teamId: 'T',
      sourceDelegationId: null,
    })

    const child = createCappedSubtask(db, parent.id, { title: 'mcp child' })
    expect(child.ok).toBe(true)
    expect(seen).toContainEqual({
      kind: 'task_created',
      taskId: child.ok ? child.task.id : '',
      teamId: 'T', // inherited from the parent
      sourceDelegationId: null,
    })
    expect(seen.filter((e) => e.kind === 'task_created')).toHaveLength(2)
  })

  it('a REFUSED capped create publishes nothing', () => {
    seen = []
    const denied = createCappedSubtask(db, 'no-such-parent', { title: 'orphan' })
    expect(denied).toMatchObject({ ok: false, reason: 'parent_not_found' })
    expect(seen).toHaveLength(0)
  })

  it('a throwing listener never breaks the write path', () => {
    onBoardLifecycle(() => {
      throw new Error('bad listener')
    })
    expect(() => createTask(db, { title: 'safe', teamId: 'T' })).not.toThrow()
  })
})

describe('agent inbox (durable mailbox)', () => {
  it('enqueue → undelivered → exactly-once delivery across racing channels', () => {
    const a = enqueueInbox(db, {
      agentId: 'lead',
      teamId: 'T',
      kind: 'task_update',
      body: 'X done',
    })
    enqueueInbox(db, { agentId: 'lead', teamId: 'T', kind: 'alert', body: 'Y parked' })
    enqueueInbox(db, { agentId: 'other', kind: 'signal', body: 'not yours' })

    const pending = listUndeliveredInbox(db, 'lead', { teamId: 'T' })
    expect(pending.map((r) => r.body)).toEqual(['X done', 'Y parked'])

    // Two channels race the same rows — the guard gives each row to ONE winner.
    const ids = pending.map((r) => r.id)
    const wonDigest = markInboxDelivered(db, ids, 'digest')
    const wonMcp = markInboxDelivered(db, ids, 'mcp')
    expect(wonDigest.sort()).toEqual(ids.sort())
    expect(wonMcp).toEqual([])
    expect(listUndeliveredInbox(db, 'lead')).toHaveLength(0)
    void a
  })

  it('renderInboxDigest: only the rows that FIT are marked delivered', () => {
    // The exactly-once contract lives on this return value. A caller must mark
    // ONLY `includedIds`; a row truncated out of the budget was not delivered and
    // has to ride the next digest, so returning every id silently drops notices.
    for (const n of [1, 2, 3])
      enqueueInbox(db, { agentId: 'lead', kind: 'signal', body: `msg${n}` })
    const rows = listUndeliveredInbox(db, 'lead')
    expect(rows).toHaveLength(3)

    // A budget that fits the header plus exactly one line.
    const oneLine = '[While you were away]'.length + '- msg1'.length + 1
    const tight = renderInboxDigest(rows, oneLine)
    expect(tight.includedIds).toEqual([rows[0]!.id])
    expect(tight.text).toContain('msg1')
    expect(tight.text).not.toContain('msg2')

    // Marking only the included row leaves the rest pending for the next pass.
    markInboxDelivered(db, tight.includedIds, 'digest')
    expect(listUndeliveredInbox(db, 'lead').map((r) => r.body)).toEqual(['msg2', 'msg3'])
  })

  it('splitInboxByAddressing: a signal is ambient, everything else is a request', () => {
    // `kind` carried this distinction since the mailbox shipped and nothing read
    // it, so a task result the agent had to synthesize and a peer's passing FYI
    // arrived in the same undifferentiated bullet list.
    enqueueInbox(db, { agentId: 'lead', kind: 'task_update', body: 'a finished' })
    enqueueInbox(db, { agentId: 'lead', kind: 'alert', body: 'delivery failed' })
    enqueueInbox(db, { agentId: 'lead', kind: 'signal', body: 'starting on the schema' })
    const { addressed, ambient } = splitInboxByAddressing(listUndeliveredInbox(db, 'lead'))
    expect(addressed.map((r) => r.body)).toEqual(['a finished', 'delivery failed'])
    expect(ambient.map((r) => r.body)).toEqual(['starting on the schema'])
  })

  it('packInboxRows: usedChars is what a second section has left to spend', () => {
    // The envelope renders two sections from ONE budget. If `usedChars` did not
    // report the real spend, the second section would get a fresh ceiling and the
    // mailbox's 4000-char bound would quietly become 8000.
    for (const n of [1, 2, 3])
      enqueueInbox(db, { agentId: 'lead', kind: 'signal', body: `msg${n}` })
    const rows = listUndeliveredInbox(db, 'lead')
    const twoLines = ('- msg1'.length + 1) * 2
    const first = packInboxRows(rows, twoLines)
    expect(first.bodies).toEqual(['- msg1', '- msg2'])
    expect(first.usedChars).toBe(twoLines)
    // Nothing left: the third row is not rendered and so is not marked.
    expect(packInboxRows(rows.slice(2), twoLines - first.usedChars).includedIds).toEqual([])
  })

  it('renderInboxDigest: empty input renders nothing, and an over-long row is truncated', () => {
    expect(renderInboxDigest([])).toEqual({ text: null, includedIds: [] })

    const long = 'x'.repeat(1_000)
    enqueueInbox(db, { agentId: 'lead', kind: 'alert', body: long })
    const rendered = renderInboxDigest(listUndeliveredInbox(db, 'lead'))
    expect(rendered.includedIds).toHaveLength(1) // truncated, still delivered
    expect(rendered.text!).toContain('…')
    expect(rendered.text!.length).toBeLessThan(long.length)

    // A budget too small even for one line renders nothing and marks nothing,
    // rather than emitting a header with no content.
    expect(renderInboxDigest(listUndeliveredInbox(db, 'lead'), 5)).toEqual({
      text: null,
      includedIds: [],
    })
  })

  it('lists agents holding undelivered mail (the boot-resume scan)', () => {
    enqueueInbox(db, { agentId: 'lead', teamId: 'T', kind: 'task_update', body: 'hi' })
    expect(listAgentsWithUndeliveredInbox(db)).toEqual([{ agentId: 'lead', teamId: 'T' }])
    markInboxDelivered(
      db,
      listUndeliveredInbox(db, 'lead').map((r) => r.id),
      'digest',
    )
    expect(listAgentsWithUndeliveredInbox(db)).toEqual([])
  })
})
