// The Board's "Needs you" column: everything waiting on a person. It stays
// expanded when empty (like every other column), shows pending approvals under an
// "Approval pending" heading, and shows stuck tasks with a badge naming why plus
// the action that gets each one moving. RTL + msw (onUnhandledRequest:'error').

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

// Generous async budget: the column polls `/api/tools/approvals` on mount, and
// under full-suite parallel load the fetch + re-render can exceed RTL's 1s default.
const T = { timeout: 4000 }
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import type { BoardTask } from '@/lib/boardClient'
import { useApprovalsStore } from '@/stores/approvals'
import { useConfirmStore } from '@/stores/confirm'
import { useFleetStore } from '@/stores/fleet'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { NeedsYouColumn } from '../NeedsYouColumn'

const toolApproval = {
  id: 'tc-1',
  toolName: 'delete_path',
  agentId: 'a1',
  argsSummary: '{"path":"/tmp/x"}',
  reason: 'destructive tool',
  createdAt: 1000,
  expiresAt: Date.now() + 60_000,
}

const BOUND = 'r1:deleg:agent:a1:reflectTo:lead'

function failedTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1',
    title: 'Draft the launch post',
    status: 'blocked',
    teamId: 'team1',
    assigneeAgentId: 'a1',
    sourceDelegationId: BOUND,
    attention: { reason: 'failed', failedRuns: 2, detail: 'provider out of credits' },
    ...overrides,
  }
}

function renderColumn(tasks: BoardTask[] = [], onTasksChanged = vi.fn(), onOpenTask = vi.fn()) {
  // The agent avatar on a task card reads the theme.
  render(
    <ThemeProvider>
      <NeedsYouColumn
        teamFilter="all"
        tasks={tasks}
        onOpenTask={onOpenTask}
        onTasksChanged={onTasksChanged}
      />
      <ConfirmDialog />
    </ThemeProvider>,
  )
  return { onTasksChanged, onOpenTask }
}

beforeEach(() => {
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useConfirmStore.setState({ open: false, options: null, resolver: null })
  useFleetStore.setState({
    agents: [
      { id: 'a1', name: 'Coder', teamId: 'team1' },
      { id: 'a2', name: 'Writer', teamId: 'team1' },
    ] as never,
  })
  server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
})
afterEach(() => cleanup())

describe('NeedsYouColumn', () => {
  it('stays expanded when nothing needs you, and says so', async () => {
    renderColumn()
    const column = await screen.findByTestId('board-column-needs-you', {}, T)
    expect(within(column).getByText('Needs you')).toBeInTheDocument()
    expect(within(column).getByTestId('needs-you-empty')).toHaveTextContent(
      /Nothing needs you right now/,
    )
    // No collapsed rail and no collapse control: it reads like every other column.
    expect(screen.queryByRole('button', { name: /collapse/i })).toBeNull()
  })

  it('lists a pending approval under "Approval pending"', async () => {
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
    )
    renderColumn()
    const group = await screen.findByTestId('needs-you-approvals', {}, T)
    expect(within(group).getByText(/Approval pending/)).toBeInTheDocument()
    expect(within(group).getByText(/wants to delete a file/i)).toBeInTheDocument()
    expect(screen.queryByTestId('needs-you-empty')).toBeNull()
  })

  it('resolving a tool approval POSTs the decision to the tool-approval endpoint', async () => {
    let resolved: { id?: string; decision?: string } = {}
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
      http.post('/api/tools/approvals/:id/resolve', async ({ params, request }) => {
        const body = (await request.json()) as { decision: string }
        resolved = { id: params['id'] as string, decision: body.decision }
        return HttpResponse.json({ ok: true })
      }),
    )
    renderColumn()
    await screen.findByText(/wants to delete a file/i, {}, T)
    await userEvent.click(screen.getByRole('button', { name: /delete it/i }))
    await waitFor(() => expect(resolved.id).toBe('tc-1'), T)
    expect(resolved.decision).toBe('allow_once')
  })

  it('marks a failed task clearly: badge, how many times, the reason, and who it belongs to', async () => {
    renderColumn([failedTask()])
    const card = await screen.findByTestId('needs-you-task', {}, T)
    expect(card).toHaveAttribute('data-attention', 'failed')
    expect(within(card).getByText('Failed 2×')).toBeInTheDocument()
    expect(within(card).getByText('provider out of credits')).toBeInTheDocument()
    expect(within(card).getByText(/Coder/)).toBeInTheDocument()
  })

  it('Retry sends the task back to its agent and asks the board to refresh', async () => {
    let retried = ''
    server.use(
      http.post('/api/board/:id/retry', ({ params }) => {
        retried = params['id'] as string
        return HttpResponse.json({ ok: true }, { status: 202 })
      }),
    )
    const { onTasksChanged } = renderColumn([failedTask()])
    await userEvent.click(await screen.findByRole('button', { name: /Retry/ }, T))
    await waitFor(() => expect(retried).toBe('t1'), T)
    await waitFor(() => expect(onTasksChanged).toHaveBeenCalled(), T)
  })

  it('an unassigned task offers the team’s agents instead of Retry', async () => {
    let assigned: { id?: string; agentId?: string } = {}
    server.use(
      http.post('/api/board/:id/assign', async ({ params, request }) => {
        const body = (await request.json()) as { agentId: string }
        assigned = { id: params['id'] as string, agentId: body.agentId }
        return HttpResponse.json({ ok: true })
      }),
    )
    renderColumn([
      failedTask({
        status: 'todo',
        assigneeAgentId: null,
        sourceDelegationId: null,
        attention: { reason: 'unassigned', failedRuns: 0 },
      }),
    ])
    const card = await screen.findByTestId('needs-you-task', {}, T)
    expect(within(card).getByText('Unassigned')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /Retry/ })).toBeNull()
    await userEvent.click(within(card).getByLabelText('Assign to an agent'))
    await userEvent.click(await screen.findByRole('option', { name: 'Writer' }, T))
    await waitFor(() => expect(assigned).toEqual({ id: 't1', agentId: 'a2' }), T)
  })

  it('Dismiss asks first, then cancels the task', async () => {
    let patched: { status?: string } | null = null
    server.use(
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: 'cancelled' } })
      }),
    )
    renderColumn([failedTask()])
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }, T))
    const dialog = await screen.findByTestId('confirm-dialog', {}, T)
    expect(patched).toBeNull() // nothing is cancelled before the person confirms
    await userEvent.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => expect(patched).toEqual({ status: 'cancelled' }), T)
  })

  it('opens the task when its card is clicked', async () => {
    const { onOpenTask } = renderColumn([failedTask()])
    await userEvent.click(
      await screen.findByRole('button', { name: /Open “Draft the launch post”/ }, T),
    )
    expect(onOpenTask).toHaveBeenCalledWith('t1')
  })
})
