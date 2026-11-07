// ActivityTerminal: the pure event→row mapping + a render off a mocked backfill.
// EventSource is guarded off in jsdom, so this exercises the durable-backfill path.

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ActivityTerminal, presentEvent } from '../ActivityTerminal'
import type { ObsLogEvent } from '../useObsStream'

/** A parsed log event (data already an object — the shape presentEvent sees). */
function parsed(seq: number, kind: string, data: Record<string, unknown>): ObsLogEvent {
  return {
    id: `e${seq}`,
    seq,
    ts: 1_700_000_000_000 + seq * 1000,
    kind,
    teamId: null,
    taskId: 't1',
    agentId: 'a2',
    runtime: 'openclaw',
    traceId: null,
    data,
  }
}

/** The wire shape from /api/obs/events: `data` is a JSON STRING (server-redacted). */
function wire(seq: number, kind: string, data: Record<string, unknown>) {
  return { ...parsed(seq, kind, data), data: JSON.stringify(data) }
}

afterEach(() => cleanup())

describe('presentEvent', () => {
  it('renders a grant decision with its REASON, not a bare badge', () => {
    // GrantDecisionData carries neither `message` nor `detail`, so the default
    // branch produced an empty row: a denial invisible in the surface built to
    // show it. "denied" with no reason is equally useless to an operator.
    const denied = presentEvent(
      parsed(1, 'grant_decision', {
        decision: 'deny',
        reason: 'lethal-trifecta',
        toolName: 'gh_read',
        grantId: 'g1',
      }),
    )
    expect(denied).toMatchObject({ tone: 'error', badge: 'grant', label: 'gh_read' })
    expect(denied?.body).toContain('lethal-trifecta')

    expect(
      presentEvent(parsed(2, 'grant_decision', { decision: 'allow', toolName: 't' }))?.tone,
    ).toBe('success')
    expect(
      presentEvent(parsed(3, 'grant_decision', { decision: 'require_approval', toolName: 't' }))
        ?.tone,
    ).toBe('idle')
  })

  it('names the tool an approval is for', () => {
    // The event carries the tool's name and never its arguments, so the name is
    // the only thing that tells two pending approvals apart in the feed.
    expect(
      presentEvent(
        parsed(5, 'approval_requested', { approvalId: 'ap1', kind: 'tool', toolName: 'gh_write' }),
      ),
    ).toMatchObject({ tone: 'warning', badge: 'approval', label: 'gh_write', body: 'requested' })
    expect(
      presentEvent(
        parsed(6, 'approval_resolved', {
          approvalId: 'ap1',
          decision: 'deny',
          toolName: 'gh_write',
        }),
      ),
    ).toMatchObject({ tone: 'idle', badge: 'approval', label: 'gh_write', body: 'deny' })
  })

  it('renders connector health with its detail', () => {
    const row = presentEvent(
      parsed(4, 'connector_health', {
        connectorId: 'conn:native:x',
        health: 'needs-auth',
        detail: 'token expired',
      }),
    )
    expect(row).toMatchObject({ tone: 'error', badge: 'connector', label: 'conn:native:x' })
    expect(row?.body).toContain('token expired')
    expect(
      presentEvent(parsed(5, 'connector_health', { connectorId: 'c', health: 'ok' }))?.tone,
    ).toBe('success')
  })

  it('maps tool_call / tool_result / error / cost to the right tone + badge', () => {
    expect(presentEvent(parsed(1, 'tool_call', { name: 'edit', input: {} }))).toMatchObject({
      badge: 'tool',
      label: 'edit',
    })
    expect(
      presentEvent(parsed(2, 'tool_result', { name: 'edit', output: 'ok', isError: false }))?.tone,
    ).toBe('success')
    expect(
      presentEvent(parsed(3, 'tool_result', { name: 'edit', output: 'boom', isError: true }))?.tone,
    ).toBe('error')
    expect(presentEvent(parsed(4, 'error', { message: 'kaboom' }))).toMatchObject({
      tone: 'error',
      body: 'kaboom',
    })
    expect(
      presentEvent(parsed(5, 'cost', { costUsd: 0.01, inputTokens: 10, outputTokens: 5 }))?.tone,
    ).toBe('warning')
  })

  it('marks a blocked status_changed + a failed execution as errors', () => {
    expect(presentEvent(parsed(1, 'status_changed', { to: 'blocked' }))?.tone).toBe('error')
    expect(
      presentEvent(parsed(2, 'execution_completed', { status: 'failed', error: 'x' }))?.tone,
    ).toBe('error')
    expect(presentEvent(parsed(3, 'execution_completed', { status: 'succeeded' }))?.tone).toBe(
      'done',
    )
  })

  it('words a report and a plan, which move nothing, instead of repeating the status', () => {
    expect(
      presentEvent(
        parsed(1, 'status_changed', {
          to: 'in_progress',
          reason: 'result_reported',
          outcome: 'not_done',
        }),
      ),
    ).toMatchObject({ badge: 'report', body: 'Not done' })
    expect(
      presentEvent(
        parsed(2, 'status_changed', {
          to: 'in_progress',
          reason: 'result_reported',
          outcome: 'done',
        }),
      ),
    ).toMatchObject({ badge: 'report', body: 'Done' })
    expect(
      presentEvent(
        parsed(3, 'status_changed', { to: 'blocked', reason: 'plan_written', revision: 2 }),
      ),
    ).toMatchObject({ badge: 'plan', body: 'Revision 2', tone: 'idle' })
  })

  it('names a status, a run’s outcome and who claimed it as the board does', () => {
    expect(presentEvent(parsed(1, 'status_changed', { to: 'in_progress' }))?.body).toBe(
      'In progress',
    )
    expect(presentEvent(parsed(2, 'execution_completed', { status: 'budget_paused' }))?.label).toBe(
      'Stopped by a budget cap',
    )
    expect(
      presentEvent(parsed(3, 'task_claimed', { assigneeAgentId: 'a1' }), (id) =>
        id === 'a1' ? 'Coder' : '',
      )?.body,
    ).toBe('Coder')
  })

  it('says why a wake waits in words a person can act on', () => {
    const skipped = presentEvent(
      {
        ...parsed(1, 'task_wake_skipped', { reason: 'run_unproven', wakeReason: 'person_comment' }),
        agentId: 'a1',
      },
      (id) => (id === 'a1' ? 'Coder' : ''),
    )
    expect(skipped).toMatchObject({
      badge: 'wake',
      label: 'A person commented',
      body: 'The run on this task stopped answering. Coder reads this once it is cleared',
    })
    expect(presentEvent(parsed(2, 'task_wake_recorded', { reason: 'dependency_done' }))?.body).toBe(
      'The task it waits on is done',
    )
    expect(
      presentEvent(parsed(3, 'task_wake_skipped', { reason: 'finished', wakeReason: 'reopened' }))
        ?.body,
    ).toBe('The task had already finished')
  })

  it('drops pure trace bookkeeping (span_start / span_end / dep_linked)', () => {
    expect(presentEvent(parsed(1, 'span_start', { name: 'run' }))).toBeNull()
    expect(presentEvent(parsed(2, 'span_end', { name: 'run' }))).toBeNull()
    expect(presentEvent(parsed(3, 'dep_linked', {}))).toBeNull()
  })
})

describe('ActivityTerminal', () => {
  it('renders tool + error rows from the backfill', async () => {
    server.use(
      http.get('/api/obs/events', () =>
        HttpResponse.json({
          events: [
            wire(1, 'tool_call', { name: 'read_file', input: { path: 'x.ts' } }),
            wire(2, 'error', { message: 'TypeError: cannot read x', fatal: true }),
          ],
        }),
      ),
    )
    render(<ActivityTerminal scope={{ taskId: 't1' }} />)
    expect(await screen.findByText('read_file')).toBeInTheDocument()
    expect(await screen.findByText(/TypeError/)).toBeInTheDocument()
    // kind badges
    expect(screen.getByText('tool')).toBeInTheDocument()
    expect(screen.getByText('error')).toBeInTheDocument()
  })

  it('backfills the RECENT window (order=desc) and still renders chronologically', async () => {
    let requestedOrder: string | null = null
    server.use(
      http.get('/api/obs/events', ({ request }) => {
        requestedOrder = new URL(request.url).searchParams.get('order')
        // A desc feed: newest first, the way the server returns it.
        return HttpResponse.json({
          events: [
            wire(2, 'tool_call', { name: 'newer_call', input: {} }),
            wire(1, 'tool_call', { name: 'older_call', input: {} }),
          ],
        })
      }),
    )
    render(<ActivityTerminal scope={{ taskId: 't1' }} />)
    expect(await screen.findByText('older_call')).toBeInTheDocument()
    // `asc` would backfill the FIRST N events ever recorded for this scope, on a
    // log nothing prunes, and seed the SSE cursor from them so the tail replays
    // the whole log forward.
    expect(requestedOrder).toBe('desc')
    // The hook reverses the window, so the terminal still reads oldest → newest.
    const shown = screen.getAllByText(/older_call|newer_call/).map((n) => n.textContent)
    expect(shown).toEqual(['older_call', 'newer_call'])
  })

  it('says there is no activity in one quiet line, not a tall mono box (task drawer)', async () => {
    server.use(http.get('/api/obs/events', () => HttpResponse.json({ events: [] })))
    render(<ActivityTerminal scope={{ taskId: 't1' }} maxHeight={260} hideHeader />)
    const empty = await screen.findByTestId('activity-empty')
    // Short enough to sit on one line beside the Live mark in a 520px drawer.
    expect(empty.querySelector('p')?.textContent).toBe(
      'No activity yet. It shows up here as agents work.',
    )
    // Prose, in the body font and the muted token: not inside the mono log.
    expect(empty.closest('.font-data')).toBeNull()
    expect(empty.querySelector('p')).toHaveClass('text-xs', 'text-muted-foreground')
    // No disc-and-title empty state in a capped host.
    expect(screen.queryByRole('heading')).toBeNull()
    // Liveness still shows, on the same line.
    expect(empty).toHaveTextContent(/Live|Reconnecting/)
  })

  it('keeps the branded empty state for a host that fills a panel', async () => {
    server.use(http.get('/api/obs/events', () => HttpResponse.json({ events: [] })))
    render(<ActivityTerminal scope={{ agentId: 'a1' }} fill hideHeader />)
    expect(await screen.findByText('No activity yet')).toBeInTheDocument()
    expect(screen.getByTestId('activity-empty').closest('.font-data')).toBeNull()
  })

  it('surfaces a live indicator under hideHeader without covering the first line', async () => {
    server.use(
      http.get('/api/obs/events', () =>
        HttpResponse.json({ events: [wire(1, 'tool_call', { name: 'x', input: {} })] }),
      ),
    )
    const { container } = render(<ActivityTerminal scope={{ taskId: 't1' }} hideHeader />)
    expect(await screen.findByText('x')).toBeInTheDocument()
    // jsdom has no EventSource → the tail can't open → the label reads "Reconnecting".
    // The point is liveness IS surfaced under hideHeader, not hidden.
    const label = screen.getByText(/Live|Reconnecting/)
    // On a strip of its own above the log, not floated over it: the pill used
    // to be absolutely positioned and sat on top of the first event line.
    for (let el: HTMLElement | null = label; el && el !== container; el = el.parentElement) {
      expect(el.style.position).not.toBe('absolute')
    }
    const log = container.querySelector('.font-data')!
    expect(log.contains(label)).toBe(false)
    expect(label.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('collapses long tool output behind a disclosure', async () => {
    const big = 'lorem '.repeat(60) // > the EXPAND_AT threshold
    server.use(
      http.get('/api/obs/events', () =>
        HttpResponse.json({
          events: [wire(1, 'tool_result', { name: 'grep', output: big, isError: false })],
        }),
      ),
    )
    const { container } = render(<ActivityTerminal scope={{ taskId: 't1' }} />)
    expect(await screen.findByText('result')).toBeInTheDocument()
    expect(container.querySelector('details')).toBeTruthy()
  })
})
