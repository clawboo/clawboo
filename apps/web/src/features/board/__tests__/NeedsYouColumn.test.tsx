// The Board's "Needs you" column: everything waiting on a person. It stays
// expanded when empty (like every other column), shows pending approvals and stuck
// tasks (with group headings only when both are there), and gives each stuck task
// the reason it waits plus the one action that gets it moving, with the rest
// (Dismiss, handing it to someone else) in the card's menu. The calendar draws the
// same cards in today's row, gathers tasks that broke the same way onto one card
// with batch actions, lets a card that is done animate out, and keeps a keyboard
// user's place when a focused card leaves.
// RTL + msw (onUnhandledRequest:'error').

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'

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
import { useToastStore } from '@/stores/toast'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { longDate, timeLabel } from '../calendar/calendarFormat'
import { NeedsYouColumn, NeedsYouItems, useNeedsYou } from '../NeedsYouColumn'

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

/** An OpenClaw agent asking to run a shell command. */
const execApproval = {
  id: 'ex-1',
  agentId: 'a1',
  sessionKey: null,
  command: 'rm -rf build',
  cwd: null,
  host: null,
  security: null,
  ask: null,
  resolvedPath: null,
  createdAtMs: 500,
  expiresAtMs: Date.now() + 60_000,
  resolving: false,
  error: null,
}

const withExecApproval = () =>
  useApprovalsStore.setState({ pendingApprovals: new Map([[execApproval.id, execApproval]]) })

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
  useToastStore.setState({ toasts: [], announcement: null })
  useFleetStore.setState({
    agents: [
      { id: 'a1', name: 'Coder', teamId: 'team1' },
      { id: 'a2', name: 'Writer', teamId: 'team1' },
    ] as never,
  })
  server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
})
afterEach(() => cleanup())

/** Opens a card's menu and picks an item: Dismiss and the agents a task can go
 *  to live there, beside the one action the card leads with. */
async function pickFromMenu(scope: HTMLElement, item: string | RegExp) {
  await userEvent.click(within(scope).getByRole('button', { name: /^More for/ }))
  await userEvent.click(await screen.findByRole('menuitem', { name: item }, T))
}

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

  it('lists a lone pending approval without a group heading', async () => {
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
    )
    renderColumn()
    const group = await screen.findByTestId('needs-you-approvals', {}, T)
    expect(within(group).getByText(/wants to delete a file/i)).toBeInTheDocument()
    expect(within(group).queryByText(/Approval pending/)).toBeNull()
    expect(screen.queryByTestId('needs-you-empty')).toBeNull()
  })

  it('draws the command card in the board look in the column too, not red', async () => {
    withExecApproval()
    renderColumn()
    const group = await screen.findByTestId('needs-you-approvals', {}, T)
    expect(within(group).queryByText('Exec Approval')).toBeNull()
    const allow = within(group).getByRole('button', { name: 'Allow Once' })
    expect(allow.className).toContain('bg-foreground')
    expect(allow.className).not.toMatch(/primary-solid/)
  })

  it('heads each group, with its count, when approvals and tasks both wait', async () => {
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
    )
    renderColumn([failedTask()])
    const approvals = await screen.findByTestId('needs-you-approvals', {}, T)
    expect(within(approvals).getByText('Approval pending')).toHaveTextContent('Approval pending1')
    const tasks = screen.getByTestId('needs-you-tasks')
    expect(within(tasks).getByText('Tasks')).toHaveTextContent('Tasks1')
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
    await userEvent.click(within(card).getByRole('button', { name: 'Assign' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Writer' }, T))
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
    await pickFromMenu(await screen.findByTestId('needs-you-task', {}, T), 'Dismiss')
    const dialog = await screen.findByTestId('confirm-dialog', {}, T)
    expect(patched).toBeNull() // nothing is cancelled before the person confirms
    await userEvent.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => expect(patched).toEqual({ status: 'cancelled' }), T)
  })

  it('says when Dismiss also cancelled the plan steps waiting on the task', async () => {
    server.use(
      http.patch('/api/board/t1', () =>
        HttpResponse.json({
          ok: true,
          task: { id: 't1', status: 'cancelled' },
          cancelledDependents: [
            { id: 's2', title: 'Step two' },
            { id: 's3', title: 'Step three' },
          ],
        }),
      ),
    )
    renderColumn([failedTask()])
    await pickFromMenu(await screen.findByTestId('needs-you-task', {}, T), 'Dismiss')
    await userEvent.click(
      within(await screen.findByTestId('confirm-dialog', {}, T)).getByTestId('confirm-ok'),
    )
    await waitFor(
      () =>
        expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
          'Task dismissed. 2 later steps waiting on it were cancelled too.',
        ]),
      T,
    )
  })

  it('opens the task when its card is clicked', async () => {
    const { onOpenTask } = renderColumn([failedTask()])
    await userEvent.click(
      await screen.findByRole('button', { name: /Open “Draft the launch post”/ }, T),
    )
    expect(onOpenTask).toHaveBeenCalledWith('t1')
  })

  it('keeps a card per task, even when several broke the same way', async () => {
    renderColumn(sameCause(3))
    await waitFor(() => expect(screen.getAllByTestId('needs-you-task')).toHaveLength(3), T)
    expect(screen.queryByTestId('needs-you-group')).toBeNull()
  })
})

const LLAMA = "404 model 'llama3.2' not found"

/** `n` tasks whose runs all failed on the same missing model. */
function sameCause(n: number, from = 1): BoardTask[] {
  return Array.from({ length: n }, (_, i) =>
    failedTask({
      id: `t${from + i}`,
      title: `Task ${from + i}`,
      assigneeAgentId: i % 2 === 0 ? 'a1' : 'a2',
      sourceDelegationId: `r${from + i}:deleg:agent:a1:reflectTo:lead`,
      attention: { reason: 'failed', failedRuns: 1, detail: LLAMA },
    }),
  )
}

// The calendar's today row draws the same items as compact amber chips.
function CellItems({
  tasks,
  onTasksChanged,
  onOpenTask,
}: {
  tasks: BoardTask[]
  onTasksChanged: () => void
  onOpenTask: (id: string) => void
}) {
  const model = useNeedsYou('all', tasks)
  return (
    <NeedsYouItems
      model={model}
      teamFilter="all"
      onOpenTask={onOpenTask}
      onTasksChanged={onTasksChanged}
      layout="cell"
      cap={3}
    />
  )
}

function renderCell(tasks: BoardTask[] = [], onTasksChanged = vi.fn(), onOpenTask = vi.fn()) {
  // The items sit in today's cell, as on the board, with something else on the
  // page beside them.
  const tree = (list: BoardTask[]) => (
    <ThemeProvider>
      <button type="button">Elsewhere</button>
      <div data-testid="calendar-needs-you-today" tabIndex={-1}>
        <CellItems tasks={list} onTasksChanged={onTasksChanged} onOpenTask={onOpenTask} />
      </div>
      <ConfirmDialog />
    </ThemeProvider>
  )
  const view = render(tree(tasks))
  /** The board's next read: what still needs the person. */
  const rerender = (list: BoardTask[]) => view.rerender(tree(list))
  return { onTasksChanged, onOpenTask, rerender }
}

/** Collects the ids a batch action hit, answering each with `refuse` for the
 *  ones it names. */
function serveRetries(refuse: string[] = []) {
  const retried: string[] = []
  server.use(
    http.post('/api/board/:id/retry', ({ params }) => {
      const id = params['id'] as string
      retried.push(id)
      return refuse.includes(id)
        ? HttpResponse.json({ ok: false, error: 'not_retryable' }, { status: 409 })
        : HttpResponse.json({ ok: true }, { status: 202 })
    }),
  )
  return retried
}

describe('Needs you in the calendar’s today row', () => {
  it('leads with the reason in amber words, not a pill, and keeps when it started waiting', async () => {
    const since = new Date(2026, 9, 12, 9, 14).getTime()
    renderCell([failedTask({ updatedAt: since })])
    const card = await screen.findByTestId('needs-you-task', {}, T)
    const reason = within(card).getByText('Failed 2×')
    expect(reason.closest('.board-reason')).not.toBeNull()
    expect(reason.closest('.uppercase')).toBeNull()

    const line = within(card).getByTestId('needs-you-since')
    expect(line).toHaveAttribute('title', `Waiting since ${longDate(since)}, ${timeLabel(since)}`)
    expect(line).toContainElement(reason)
    expect(within(line).getByText('provider out of credits')).toBeInTheDocument()

    const open = within(card).getByRole('button', { name: /Open “Draft the launch post”/ })
    expect(open).toHaveAccessibleDescription(/Failed 2×.*provider out of credits.*Waiting since/)
  })

  it('leads with Retry as a quiet word, with Dismiss in the card menu', async () => {
    let retried = ''
    server.use(
      http.post('/api/board/:id/retry', ({ params }) => {
        retried = params['id'] as string
        return HttpResponse.json({ ok: true }, { status: 202 })
      }),
    )
    const { onTasksChanged } = renderCell([failedTask()])
    const card = await screen.findByTestId('needs-you-task', {}, T)
    expect(within(card).queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(within(card).getByRole('button', { name: /^More for/ })).toBeVisible()
    await userEvent.click(within(card).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(retried).toBe('t1'), T)
    await waitFor(() => expect(onTasksChanged).toHaveBeenCalled(), T)
  })

  it('draws a command approval in amber words with ink and outline buttons, not red', async () => {
    withExecApproval()
    renderCell([])
    const group = await screen.findByTestId('needs-you-approvals', {}, T)
    expect(
      within(group).getByText('Wants to run a command').closest('.board-reason'),
    ).not.toBeNull()
    expect(within(group).queryByText('Exec Approval')).toBeNull()
    expect(group.querySelector('.uppercase')).toBeNull()
    expect(within(group).getByText('rm -rf build')).toHaveClass('font-mono')

    const allow = within(group).getByRole('button', { name: 'Allow Once' })
    const always = within(group).getByRole('button', { name: 'Always' })
    const deny = within(group).getByRole('button', { name: 'Deny' })
    expect(allow.className).toContain('bg-foreground')
    for (const button of [allow, always, deny]) {
      expect(button.className).not.toMatch(/primary-solid|destructive/)
    }
    expect(always.className).toContain('border-border-strong')
    expect(deny.className).toContain('border-border-strong')
  })

  it('shows a calm Boo when nothing needs you', async () => {
    renderCell([])
    const empty = await screen.findByTestId('needs-you-empty', {}, T)
    expect(empty).toHaveTextContent('Nothing needs you right now')
    // A Boo, not the check-circle icon the undated lane keeps.
    const art = empty.querySelector('svg')
    expect(art).not.toBeNull()
    expect(art).not.toHaveClass('lucide')
  })
})

describe('Needs you groups tasks that broke the same way', () => {
  it('puts them on one card that leads with the cause and lists each task', async () => {
    const other = failedTask({ id: 'x1', title: 'Other work' })
    renderCell([...sameCause(3), other])
    const group = await screen.findByTestId('needs-you-group', {}, T)
    expect(screen.getAllByTestId('needs-you-group')).toHaveLength(1)
    expect(group).toHaveAttribute('data-attention', 'failed')
    expect(group).toHaveAccessibleName(LLAMA)
    expect(within(group).getByText('Failed · 3 tasks').closest('.board-reason')).not.toBeNull()

    const rows = within(group).getAllByTestId('needs-you-task')
    expect(rows.map((r) => r.textContent)).toEqual(['Task 1', 'Task 2', 'Task 3'])
    rows.forEach((r) => expect(r).toHaveAttribute('data-attention', 'failed'))

    // A different cause keeps its own card, outside the group.
    const others = screen.getAllByTestId('needs-you-task').filter((el) => !group.contains(el))
    expect(others).toHaveLength(1)
    expect(others[0]).toHaveTextContent('Other work')
  })

  it('reads run ids and timestamps out of the cause, and keeps different causes apart', async () => {
    const run = (id: string, at: string) => `Run ${id} failed at ${at}: model not found`
    renderCell([
      failedTask({
        id: 't1',
        attention: {
          reason: 'failed',
          failedRuns: 1,
          detail: run('3f2a1b4c-0d1e-4f5a-8b9c-0d1e2f3a4b5c', '2026-10-12T09:14:00Z'),
        },
      }),
      failedTask({
        id: 't2',
        attention: {
          reason: 'failed',
          failedRuns: 1,
          detail: run('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', '2026-10-12T11:02:31.512Z'),
        },
      }),
      // The same cause for a different reason, and a different cause, stay apart.
      failedTask({
        id: 't3',
        attention: {
          reason: 'timed_out',
          failedRuns: 1,
          detail: run('1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', '2026-10-12T12:00:00Z'),
        },
      }),
      failedTask({ id: 't4', attention: { reason: 'failed', failedRuns: 1, detail: 'quota' } }),
    ])
    const group = await screen.findByTestId('needs-you-group', {}, T)
    expect(screen.getAllByTestId('needs-you-group')).toHaveLength(1)
    expect(within(group).getByText('Run … failed at …: model not found')).toBeInTheDocument()
    expect(within(group).getAllByTestId('needs-you-task')).toHaveLength(2)
    expect(screen.getAllByTestId('needs-you-task')).toHaveLength(4)
  })

  it('Retry all sends every task back at once, then says so in one toast', async () => {
    const retried = serveRetries()
    const { onTasksChanged } = renderCell(sameCause(3))
    const group = await screen.findByTestId('needs-you-group', {}, T)
    await userEvent.click(within(group).getByRole('button', { name: 'Retry all 3 tasks' }))
    await waitFor(() => expect([...retried].sort()).toEqual(['t1', 't2', 't3']), T)
    await waitFor(() => expect(onTasksChanged).toHaveBeenCalledTimes(1), T)
    const toasts = useToastStore.getState().toasts
    expect(toasts.map((t) => [t.type, t.message])).toEqual([['success', 'Retrying 3 tasks.']])
  })

  it('says how many went through when the server refuses one', async () => {
    serveRetries(['t2'])
    const { onTasksChanged } = renderCell(sameCause(3))
    await userEvent.click(await screen.findByRole('button', { name: /Retry all/ }, T))
    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1), T)
    expect(useToastStore.getState().toasts[0]?.message).toBe('Retried 2 of 3. One was refused.')
    await waitFor(() => expect(onTasksChanged).toHaveBeenCalled(), T)
  })

  it('Dismiss all asks once, naming the count, then cancels each', async () => {
    const patched: string[] = []
    server.use(
      http.patch('/api/board/:id', async ({ params, request }) => {
        const body = (await request.json()) as { status: string }
        if (body.status === 'cancelled') patched.push(params['id'] as string)
        return HttpResponse.json({ ok: true })
      }),
    )
    renderCell(sameCause(3))
    await pickFromMenu(await screen.findByTestId('needs-you-group', {}, T), 'Dismiss all')
    const dialog = await screen.findByTestId('confirm-dialog', {}, T)
    expect(within(dialog).getByText('Dismiss 3 tasks?')).toBeInTheDocument()
    expect(patched).toEqual([]) // nothing is cancelled before the person confirms
    await userEvent.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => expect([...patched].sort()).toEqual(['t1', 't2', 't3']), T)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['Dismissed 3 tasks.'])
  })

  it('offers Retry all only when every task in the group can run again', async () => {
    const [a, b] = sameCause(2) as [BoardTask, BoardTask]
    // Nobody is bound to the second, so a person has to pick who runs it.
    renderCell([a, { ...b, assigneeAgentId: null, sourceDelegationId: null }])
    const group = await screen.findByTestId('needs-you-group', {}, T)
    expect(within(group).queryByRole('button', { name: /Retry all/ })).toBeNull()
    // Dismiss all is still there, in the group's menu.
    expect(within(group).getByRole('button', { name: 'More for 2 tasks' })).toBeVisible()
  })

  it('opens a task from its row', async () => {
    const { onOpenTask } = renderCell(sameCause(3))
    const group = await screen.findByTestId('needs-you-group', {}, T)
    await userEvent.click(within(group).getByRole('button', { name: 'Open “Task 2”' }))
    expect(onOpenTask).toHaveBeenCalledWith('t2')
  })

  it('counts a group as one card against the cap, and the rest as tasks', async () => {
    const singles = ['quota', 'disk full', 'no route'].map((detail, i) =>
      failedTask({
        id: `s${i}`,
        title: `Single ${i}`,
        attention: { reason: 'failed', failedRuns: 1, detail },
      }),
    )
    renderCell([...sameCause(3), ...singles])
    // The group plus two singles fill the cap of three; the third single waits.
    await screen.findByTestId('needs-you-group', {}, T)
    expect(screen.getAllByTestId('needs-you-task')).toHaveLength(5)
    expect(screen.queryByText('Single 2')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '+1 more' }))
    expect(screen.getByText('Single 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('opens the cards past the cap when one of them is being brought into view', async () => {
    const singles = ['quota', 'disk full', 'no route', 'bad key'].map((detail, i) =>
      failedTask({
        id: `s${i}`,
        title: `Single ${i}`,
        attention: { reason: 'failed', failedRuns: 1, detail },
      }),
    )
    function Shown({ show }: { show: string | null }) {
      const model = useNeedsYou('all', singles)
      return (
        <NeedsYouItems
          model={model}
          teamFilter="all"
          onOpenTask={() => {}}
          onTasksChanged={() => {}}
          layout="cell"
          cap={3}
          show={show}
        />
      )
    }
    const view = render(
      <ThemeProvider>
        <Shown show={null} />
      </ThemeProvider>,
    )
    await screen.findByText('Single 0', {}, T)
    expect(screen.queryByText('Single 3')).toBeNull()
    // Find, or "Open on board", brings the fourth card into view.
    view.rerender(
      <ThemeProvider>
        <Shown show="s3" />
      </ThemeProvider>,
    )
    expect(screen.getByText('Single 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('lets a card that no longer needs you leave, then says nothing does', async () => {
    // Measuring the closing height restores the scroll position, which jsdom lacks.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { rerender } = renderCell(sameCause(3))
    const group = await screen.findByTestId('needs-you-group', {}, T)
    // One task of the group went back to work: its row leaves, the card stays.
    rerender(sameCause(3).slice(1))
    await waitFor(() => expect(within(group).getAllByTestId('needs-you-task')).toHaveLength(2), T)
    expect(within(group).getByText('Failed · 2 tasks')).toBeInTheDocument()
    // The rest went too: the card leaves, and the calm empty state follows it.
    rerender([])
    await waitFor(() => expect(screen.queryByTestId('needs-you-group')).toBeNull(), T)
    expect(await screen.findByTestId('needs-you-empty', {}, T)).toHaveTextContent(
      'Nothing needs you right now',
    )
  })
})

/** A failed task with a cause of its own, so it keeps its own card. */
function single(id: string, title: string, detail: string): BoardTask {
  return failedTask({ id, title, attention: { reason: 'failed', failedRuns: 1, detail } })
}

/** The open button of the card or group row for `title` that is staying. */
function openButton(title: string): HTMLElement {
  const staying = screen
    .getAllByRole('button', { name: `Open “${title}”` })
    .find((el) => !el.closest('[data-leaving]'))
  if (!staying) throw new Error(`no staying card for ${title}`)
  return staying
}

describe('Needs you keeps a keyboard user’s place when a card leaves', () => {
  beforeEach(() => {
    // Measuring the closing height restores the scroll position, which jsdom lacks.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  })

  it('moves focus to the next card when the focused one goes', async () => {
    const a = single('t1', 'Card A', 'quota')
    const b = single('t2', 'Card B', 'disk full')
    const { rerender } = renderCell([a, b])
    await screen.findByRole('button', { name: 'Open “Card A”' }, T)
    openButton('Card A').focus()
    rerender([b])
    expect(document.activeElement).toBe(openButton('Card B'))
  })

  it('follows a task onto the group it joins, and back onto a card of its own', async () => {
    const other = single('x1', 'Other work', 'quota')
    const [one, two] = sameCause(2) as [BoardTask, BoardTask]
    const { rerender } = renderCell([one, other])
    await screen.findByRole('button', { name: 'Open “Task 1”' }, T)
    openButton('Task 1').focus()

    // A second run failed the same way: Task 1's card becomes a row of the group.
    rerender([one, two, other])
    const group = screen.getByTestId('needs-you-group')
    expect(document.activeElement).toBe(
      within(group).getByRole('button', { name: 'Open “Task 1”' }),
    )

    // Task 2 went back to work: the group splits, and focus is on Task 1's card again.
    rerender([one, other])
    expect(document.activeElement).toBe(openButton('Task 1'))
    expect(document.activeElement?.closest('[data-testid="needs-you-group"]')).toBeNull()
  })

  it('Retry all hands focus to the next card once the group goes', async () => {
    serveRetries()
    const other = single('x1', 'Other work', 'quota')
    const onTasksChanged = vi.fn()
    const { rerender } = renderCell([...sameCause(3), other], onTasksChanged)
    onTasksChanged.mockImplementation(() => rerender([other]))
    const group = await screen.findByTestId('needs-you-group', {}, T)
    await userEvent.click(within(group).getByRole('button', { name: 'Retry all 3 tasks' }))
    await waitFor(() => expect(document.activeElement).toBe(openButton('Other work')), T)
  })

  it('moves focus on after a confirmed Dismiss, and back to the menu when the person backs out', async () => {
    server.use(http.patch('/api/board/:id', () => HttpResponse.json({ ok: true })))
    const a = single('t1', 'Card A', 'quota')
    const b = single('t2', 'Card B', 'disk full')
    const onTasksChanged = vi.fn()
    const { rerender } = renderCell([a, b], onTasksChanged)
    onTasksChanged.mockImplementation(() => rerender([b]))
    await screen.findByRole('button', { name: 'Open “Card A”' }, T)
    const cardA = openButton('Card A').closest('[data-testid="needs-you-task"]') as HTMLElement
    const more = within(cardA).getByRole('button', { name: /^More for/ })

    await pickFromMenu(cardA, 'Dismiss')
    const asked = await screen.findByTestId('confirm-dialog', {}, T)
    await userEvent.click(within(asked).getByTestId('confirm-cancel'))
    await waitFor(() => expect(document.activeElement).toBe(more), T)
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull(), T)
    expect(onTasksChanged).not.toHaveBeenCalled()

    await pickFromMenu(cardA, 'Dismiss')
    const again = await screen.findByTestId('confirm-dialog', {}, T)
    await userEvent.click(within(again).getByTestId('confirm-ok'))
    await waitFor(() => expect(document.activeElement).toBe(openButton('Card B')), T)
  })

  it('hands focus to today’s cell when the last card goes', async () => {
    const { rerender } = renderCell([single('t1', 'Card A', 'quota')])
    await screen.findByRole('button', { name: 'Open “Card A”' }, T)
    openButton('Card A').focus()
    rerender([])
    expect(document.activeElement).toBe(screen.getByTestId('calendar-needs-you-today'))
  })

  it('leaves focus alone when it is elsewhere on the page', async () => {
    const a = single('t1', 'Card A', 'quota')
    const b = single('t2', 'Card B', 'disk full')
    const { rerender } = renderCell([a, b])
    await screen.findByRole('button', { name: 'Open “Card A”' }, T)
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    rerender([b])
    expect(document.activeElement).toBe(elsewhere)
  })

  it('hands focus to “+N more” when a new approval pushes the focused card past the cap', async () => {
    const singles = ['quota', 'disk full', 'no route'].map((detail, i) =>
      single(`s${i}`, `Single ${i}`, detail),
    )
    renderCell(singles)
    await screen.findByRole('button', { name: 'Open “Single 2”' }, T)
    openButton('Single 2').focus()
    // Approvals come first, so the last card moves behind "+1 more".
    act(() => withExecApproval())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+1 more' }))
  })

  it('hands focus from an answered approval to a task still waiting', async () => {
    withExecApproval()
    renderCell([single('t1', 'Card A', 'quota')])
    const allow = await screen.findByRole('button', { name: 'Allow Once' }, T)
    allow.focus()
    act(() => useApprovalsStore.setState({ pendingApprovals: new Map() }))
    expect(document.activeElement).toBe(openButton('Card A'))
  })
})
