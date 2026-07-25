// Task-detail drawer. Rendered via props (taskId / onClose), so it tests in
// isolation without driving BoardPanel. On mount it loads GET /api/board/:id,
// /executions, and /workspace/detail. The drawer is READ-ONLY — it displays
// comments but has no compose box, so the user interaction is the Close button.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { TaskDetailDrawer } from '../TaskDetailDrawer'

afterEach(() => cleanup())

function detailHandlers() {
  return [
    http.get('/api/board/t1', () =>
      HttpResponse.json({
        task: { id: 't1', title: 'Ship it', status: 'in_review' },
        comments: [{ body: 'looks good', authorType: 'system' }],
        ancestors: [],
      }),
    ),
    http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
    // The Workspace section always fetches; default to "no worktree provisioned".
    http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
    // The Activity section mounts an ActivityTerminal → useObsStream backfills here.
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
  ]
}

// A task actively owned by an agent (in_progress + assignee) — moving it to `todo`
// would unassign that agent, so the status editor must confirm first.
function runningTaskHandlers() {
  return [
    http.get('/api/board/t1', () =>
      HttpResponse.json({
        task: { id: 't1', title: 'Ship it', status: 'in_progress', assigneeAgentId: 'agent-7' },
        comments: [],
        ancestors: [],
      }),
    ),
    http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
    http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
  ]
}

describe('TaskDetailDrawer', () => {
  it('loads + renders task detail', async () => {
    server.use(...detailHandlers())
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    expect(await screen.findByTestId('task-detail-drawer')).toBeInTheDocument()
    expect(await screen.findByText('Ship it')).toBeInTheDocument()
    // Status is now an editable Select showing the human label for `in_review`.
    expect(screen.getByTestId('task-status-select')).toHaveTextContent('In review')
    expect(screen.getByText('looks good')).toBeInTheDocument()
    // The Activity section mounts (its ActivityTerminal backfills /api/obs/events,
    // which is mocked above — so onUnhandledRequest:'error' stays a real guarantee).
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('changes status through the Select and PATCHes /api/board/:id', async () => {
    let patched: { status?: string } | null = null
    server.use(
      ...detailHandlers(), // t1 is in_review → done is a legal transition
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: patched.status } })
      }),
    )
    const user = userEvent.setup()
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    await screen.findByText('Ship it')
    await user.click(screen.getByTestId('task-status-select'))
    await user.click(await screen.findByRole('option', { name: 'Done' }))

    await waitFor(() => expect(patched).toEqual({ status: 'done' }))
  })

  it('confirms before unassigning a running agent, then PATCHes on confirm', async () => {
    let patched: { status?: string } | null = null
    server.use(
      ...runningTaskHandlers(),
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: patched.status } })
      }),
    )
    const user = userEvent.setup()
    render(
      <>
        <TaskDetailDrawer taskId="t1" onClose={() => {}} />
        <ConfirmDialog />
      </>,
    )

    await screen.findByText('Ship it')
    expect(screen.getByText('agent-7')).toBeInTheDocument() // Assignee row, pre-move
    await user.click(screen.getByTestId('task-status-select'))
    await user.click(await screen.findByRole('option', { name: 'To do' }))

    // The confirm gate intercepts — nothing is sent until the user confirms.
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(patched).toBeNull()
    await user.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => expect(patched).toEqual({ status: 'todo' }))
    // The drawer mirrors the server's release: the assignee is cleared locally, so
    // the Assignee row no longer shows a (now-detached) agent.
    await waitFor(() => expect(screen.queryByText('agent-7')).toBeNull())
  })

  it('leaves a running task assigned when the unassign confirm is cancelled', async () => {
    let patchCalls = 0
    server.use(
      ...runningTaskHandlers(),
      http.patch('/api/board/t1', () => {
        patchCalls++
        return HttpResponse.json({ ok: true })
      }),
    )
    const user = userEvent.setup()
    render(
      <>
        <TaskDetailDrawer taskId="t1" onClose={() => {}} />
        <ConfirmDialog />
      </>,
    )

    await screen.findByText('Ship it')
    await user.click(screen.getByTestId('task-status-select'))
    await user.click(await screen.findByRole('option', { name: 'To do' }))

    const dialog = await screen.findByTestId('confirm-dialog')
    await user.click(within(dialog).getByTestId('confirm-cancel'))

    // No write fired, and the control stays on the original status.
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(patchCalls).toBe(0)
    expect(screen.getByTestId('task-status-select')).toHaveTextContent('In progress')
  })

  it('moves an UNassigned task to To do with no confirm prompt', async () => {
    // The gate keys on a present assignee — an unassigned in_progress task releasing
    // to `todo` clears nothing meaningful, so it must NOT prompt.
    let patched: { status?: string } | null = null
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'in_progress' }, // no assigneeAgentId
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: patched.status } })
      }),
    )
    const user = userEvent.setup()
    render(
      <>
        <TaskDetailDrawer taskId="t1" onClose={() => {}} />
        <ConfirmDialog />
      </>,
    )

    await screen.findByText('Ship it')
    await user.click(screen.getByTestId('task-status-select'))
    await user.click(await screen.findByRole('option', { name: 'To do' }))

    await waitFor(() => expect(patched).toEqual({ status: 'todo' }))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('locks the status editor on a terminal (done) task', async () => {
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'done' },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    await screen.findByText('Ship it')
    // Terminal tasks have no legal moves → the control is disabled, not interactive.
    expect(screen.getByTestId('task-status-select')).toBeDisabled()
  })

  it('calls onClose when the Close button is clicked', async () => {
    server.use(...detailHandlers())
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<TaskDetailDrawer taskId="t1" onClose={onClose} />)

    await screen.findByText('Ship it')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the Workspace section from /workspace/detail', async () => {
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'in_review' },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () =>
        HttpResponse.json({
          ok: true,
          workspace: { branch: 'clawboo/task-t1', worktreePath: '/tmp/wt' },
          sorFiles: {},
          diffStat: { filesChanged: 1, insertions: 2, deletions: 0 },
          diff: '',
        }),
      ),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    expect(await screen.findByText('clawboo/task-t1')).toBeInTheDocument()
  })

  it('surfaces the reviewer runtime + model on the verification verdict', async () => {
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: {
            id: 't1',
            title: 'Ship it',
            status: 'in_review',
            verification: JSON.stringify({
              status: 'pass',
              attempts: [
                {
                  critic: {
                    ran: true,
                    findings: [],
                    reviewerRuntime: 'claude-code',
                    reviewerModel: 'claude-haiku-4-5',
                    reviewedSha: 'abc',
                  },
                },
              ],
              debtNotes: [],
            }),
          },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    expect(
      await screen.findByText(/Reviewed by claude-code · claude-haiku-4-5/),
    ).toBeInTheDocument()
  })
})
