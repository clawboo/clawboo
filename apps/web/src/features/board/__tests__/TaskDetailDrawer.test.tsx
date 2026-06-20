// Task-detail drawer. Rendered via props (taskId / onClose), so it tests in
// isolation without driving BoardPanel. On mount it loads GET /api/board/:id,
// /executions, and /workspace/detail. The drawer is READ-ONLY — it displays
// comments but has no compose box, so the user interaction is the Close button.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
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

describe('TaskDetailDrawer', () => {
  it('loads + renders task detail', async () => {
    server.use(...detailHandlers())
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    expect(await screen.findByTestId('task-detail-drawer')).toBeInTheDocument()
    expect(await screen.findByText('Ship it')).toBeInTheDocument()
    expect(screen.getByText('in_review')).toBeInTheDocument()
    expect(screen.getByText('looks good')).toBeInTheDocument()
    // The Activity section mounts (its ActivityTerminal backfills /api/obs/events,
    // which is mocked above — so onUnhandledRequest:'error' stays a real guarantee).
    expect(screen.getByText('Activity')).toBeInTheDocument()
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
