// Task-detail drawer. Rendered via props (taskId / onClose), so it tests in
// isolation without driving BoardPanel. On mount it loads GET /api/board/:id,
// /executions, and /workspace/detail. The drawer is READ-ONLY — it displays
// comments but has no compose box, so the user interaction is the Close button.

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useToastStore } from '@/stores/toast'
import { useFleetStore, type AgentState } from '@/stores/fleet'

import { server } from '../../../__vitest__/mswServer'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { TaskComments } from '../TaskComments'
import { TaskDetailDrawer } from '../TaskDetailDrawer'

// The agent's Boo under the title reads the theme.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ThemeProvider })

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
  it("names the boo who reported, so the task reads as a teammate's report", async () => {
    // A boo's board work stays on the board (the native driver no longer writes it
    // into the person's 1:1 chat), so this section is where they read it. Naming the
    // reporter is what makes it a teammate reporting back rather than raw output.
    useFleetStore.setState({
      agents: [{ id: 'agent-7', name: 'Coder' } as AgentState],
      selectedAgentId: null,
    })
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'done', assigneeAgentId: 'agent-7' },
          comments: [
            { body: 'Shipped and verified.', authorType: 'agent', authorAgentId: 'agent-7' },
          ],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

    expect(await screen.findByText("Coder's report")).toBeInTheDocument()
    // Once, in the named report, rendered as the markdown it is written in. The
    // Comments section keeps the rest of the log, so it is not drawn at all here.
    expect(screen.getAllByText('Shipped and verified.')).toHaveLength(1)
    expect(
      within(screen.getByTestId('task-report')).getByText('Shipped and verified.').tagName,
    ).toBe('P')
    expect(screen.queryByRole('button', { name: /^Comments/ })).toBeNull()
  })

  it('falls back to a plain heading when the boo is not in the fleet', async () => {
    useFleetStore.setState({ agents: [], selectedAgentId: null })
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'done', assigneeAgentId: 'gone' },
          comments: [{ body: 'Shipped.', authorType: 'agent', authorAgentId: 'gone' }],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    expect(await screen.findByText('Report')).toBeInTheDocument()
  })

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

  it('offers "Complete anyway" when the verification gate blocks → done, then overrides', async () => {
    const bodies: Array<{ status?: string; humanOverride?: boolean }> = []
    server.use(
      ...detailHandlers(), // t1 is in_review; → done is legal but the gate refuses it
      http.patch('/api/board/t1', async ({ request }) => {
        const body = (await request.json()) as { status: string; humanOverride?: boolean }
        bodies.push(body)
        // The server gates → done unless the human override is set (audited path).
        if (body.humanOverride) {
          return HttpResponse.json({ ok: true, task: { id: 't1', status: 'done' } })
        }
        return HttpResponse.json({ ok: false, error: 'verification_required' }, { status: 409 })
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
    await user.click(await screen.findByRole('option', { name: 'Done' }))

    // The gated attempt is refused → a "Complete anyway?" override confirm appears.
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(within(dialog).getByText(/passed verification/i)).toBeInTheDocument()
    await user.click(within(dialog).getByTestId('confirm-ok'))

    // Exactly two writes: the gated attempt, then the audited override retry.
    await waitFor(() =>
      expect(bodies).toEqual([{ status: 'done' }, { status: 'done', humanOverride: true }]),
    )
  })

  it('leaves the task unchanged when "Complete anyway" is declined', async () => {
    const bodies: Array<{ status?: string; humanOverride?: boolean }> = []
    server.use(
      ...detailHandlers(),
      http.patch('/api/board/t1', async ({ request }) => {
        bodies.push((await request.json()) as { status: string; humanOverride?: boolean })
        return HttpResponse.json({ ok: false, error: 'verification_required' }, { status: 409 })
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
    await user.click(await screen.findByRole('option', { name: 'Done' }))

    const dialog = await screen.findByTestId('confirm-dialog')
    await user.click(within(dialog).getByTestId('confirm-cancel'))

    // No override sent (only the initial gated attempt), and the editor rolled back —
    // a deliberate decline, so no error toast either.
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(bodies).toEqual([{ status: 'done' }])
    expect(screen.getByTestId('task-status-select')).toHaveTextContent('In review')
  })

  it('rolls back and reports failure when the override retry is still refused', async () => {
    useToastStore.setState({ toasts: [] })
    const bodies: Array<{ status?: string; humanOverride?: boolean }> = []
    server.use(
      ...detailHandlers(),
      // Refuse both the gated attempt AND the human-override retry.
      http.patch('/api/board/t1', async ({ request }) => {
        bodies.push((await request.json()) as { status: string; humanOverride?: boolean })
        return HttpResponse.json({ ok: false, error: 'verification_required' }, { status: 409 })
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
    await user.click(await screen.findByRole('option', { name: 'Done' }))
    await user.click(within(await screen.findByTestId('confirm-dialog')).getByTestId('confirm-ok'))

    // Both writes attempted (gated, then override), then a clean rollback + error toast.
    await waitFor(() =>
      expect(bodies).toEqual([{ status: 'done' }, { status: 'done', humanOverride: true }]),
    )
    expect(screen.getByTestId('task-status-select')).toHaveTextContent('In review')
    expect(
      useToastStore
        .getState()
        .toasts.some((t) => t.type === 'error' && /verification/i.test(t.message)),
    ).toBe(true)
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
      await screen.findByText(/Reviewed by Claude Code · claude-haiku-4-5/),
    ).toBeInTheDocument()
  })

  it('says a review did not complete instead of naming a reviewer, and flags an agent-written check', async () => {
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
                  deterministic: { command: 'echo ok', commandSource: 'agent', passed: true },
                  critic: {
                    ran: true,
                    outcome: 'errored',
                    findings: [{ severity: 'other', title: 'review did not complete' }],
                    reviewerRuntime: 'claude-code',
                    reviewerModel: null,
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

    expect(await screen.findByText('Review did not complete (Claude Code)')).toBeInTheDocument()
    expect(screen.queryByText(/Reviewed by/)).not.toBeInTheDocument()
    expect(screen.getByText('echo ok')).toBeInTheDocument()
    expect(screen.getByText(/written by the agent/)).toBeInTheDocument()
    // The verdict reads in words, with its mark.
    expect(screen.getByTestId('task-verdict')).toHaveTextContent(/^Passed$/)
  })

  describe('runtime', () => {
    /** The drawer for this task, with nothing else recorded. */
    function taskHandlers(task: Record<string, unknown>) {
      return [
        http.get('/api/board/t1', () =>
          HttpResponse.json({
            task: { id: 't1', title: 'Ship it', ...task },
            comments: [],
            ancestors: [],
          }),
        ),
        http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
        http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
        http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      ]
    }

    /** The value beside the Overview's Runtime label. */
    async function runtimeRow(): Promise<string | null> {
      const label = await screen.findByText('Runtime')
      return label.nextElementSibling?.textContent ?? null
    }

    it("names an open task's runtime from its agent, not the engine's stored placeholder", async () => {
      // The team engine stores 'openclaw' on a task until its run ends, whatever
      // the agent runs on, so open work reads the agent's own runtime.
      useFleetStore.setState({
        agents: [{ id: 'agent-7', name: 'Coder', runtime: 'codex' } as AgentState],
        selectedAgentId: null,
      })
      server.use(
        ...taskHandlers({
          status: 'in_progress',
          assigneeAgentId: 'agent-7',
          assigneeRuntime: 'openclaw',
        }),
      )
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Codex')
    })

    it('names a finished task by the runtime its run recorded', async () => {
      useFleetStore.setState({
        agents: [{ id: 'agent-7', name: 'Coder', runtime: 'codex' } as AgentState],
        selectedAgentId: null,
      })
      server.use(
        ...taskHandlers({
          status: 'done',
          assigneeAgentId: 'agent-7',
          assigneeRuntime: 'claude-code',
        }),
      )
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Claude Code')
    })

    it('says Not assigned when the task has no agent and no runtime', async () => {
      useFleetStore.setState({ agents: [], selectedAgentId: null })
      server.use(...taskHandlers({ status: 'todo' }))
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Not assigned')
    })

    it('reads the runtime of the agent a waiting task is bound to', async () => {
      // A person handed the task to an agent; it waits in To do for that agent's
      // turn with no assignee yet.
      useFleetStore.setState({
        agents: [{ id: 'agent-9', name: 'Writer', runtime: 'hermes' } as AgentState],
        selectedAgentId: null,
      })
      server.use(
        ...taskHandlers({
          status: 'todo',
          sourceDelegationId: 'assign:n1:agent:agent-9:origin:human',
        }),
      )
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Hermes')
    })

    it("falls back to the agent's runtime when a finished task recorded none", async () => {
      useFleetStore.setState({
        agents: [{ id: 'agent-7', name: 'Coder', runtime: 'hermes' } as AgentState],
        selectedAgentId: null,
      })
      server.use(...taskHandlers({ status: 'done', assigneeAgentId: 'agent-7' }))
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Hermes')
    })

    it('names a cancelled task by the runtime its run recorded, like a done one', async () => {
      useFleetStore.setState({
        agents: [{ id: 'agent-7', name: 'Coder', runtime: 'hermes' } as AgentState],
        selectedAgentId: null,
      })
      server.use(
        ...taskHandlers({
          status: 'cancelled',
          assigneeAgentId: 'agent-7',
          assigneeRuntime: 'codex',
        }),
      )
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Codex')
    })

    it.each([
      ['an open task whose agent runs it', 'in_progress', 'openclaw', 'acme'],
      ['a finished task that recorded it', 'done', 'acme', 'codex'],
    ])(
      'names a runtime the board has no brand for by its id: %s',
      async (_case, status, recorded, agentRuntime) => {
        useFleetStore.setState({
          agents: [{ id: 'agent-7', name: 'Coder', runtime: agentRuntime } as AgentState],
          selectedAgentId: null,
        })
        server.use(
          ...taskHandlers({ status, assigneeAgentId: 'agent-7', assigneeRuntime: recorded }),
        )
        render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
        expect(await runtimeRow()).toBe('acme')
      },
    )

    it('claims no runtime for open work whose agent the fleet does not know', async () => {
      // The stored 'openclaw' is the engine's placeholder, not what the agent runs on.
      useFleetStore.setState({ agents: [], selectedAgentId: null })
      server.use(
        ...taskHandlers({
          status: 'in_progress',
          assigneeAgentId: 'ghost',
          assigneeRuntime: 'openclaw',
        }),
      )
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await runtimeRow()).toBe('Unknown')
    })
  })

  describe('cost', () => {
    /** The drawer for a task with this `runCost` and these ledger rows. */
    function costHandlers(runCost: unknown, executions: unknown[] = []) {
      return [
        http.get('/api/board/t1', () =>
          HttpResponse.json({
            task: { id: 't1', title: 'Ship it', status: 'done', costUsd: 0, runCost },
            comments: [],
            ancestors: [],
          }),
        ),
        http.get('/api/board/t1/executions', () => HttpResponse.json({ executions })),
        http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
        http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      ]
    }
    /** The value beside the Cost label in the drawer's detail rows. */
    const costValue = () => screen.getByText('Cost').nextElementSibling

    it('shows the run-ledger total to four decimals, marked when estimated', async () => {
      server.use(...costHandlers({ usd: 0.0042, estimated: true }))
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      await screen.findByText('Ship it')
      expect(costValue()).toHaveTextContent(/^~\$0\.0042 est\.$/)
    })

    it('shows a reported $0 as a cost', async () => {
      server.use(...costHandlers({ usd: 0, estimated: false }))
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      await screen.findByText('Ship it')
      expect(costValue()).toHaveTextContent(/^\$0\.0000$/)
    })

    it('says no cost is recorded when no run recorded one', async () => {
      server.use(...costHandlers({ usd: null, estimated: false }))
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      await screen.findByText('Ship it')
      expect(costValue()).toHaveTextContent(/^None recorded$/)
    })

    it('names the runtime each run used and marks an estimated run cost', async () => {
      server.use(
        ...costHandlers({ usd: 0.1242, estimated: true }, [
          {
            id: 'e1',
            executorType: 'openclaw',
            runtime: 'codex',
            status: 'succeeded',
            costUsd: 0.0042,
            costSource: 'token-estimate',
          },
          {
            id: 'e2',
            executorType: 'claude-code',
            status: 'succeeded',
            costUsd: 0.12,
            costSource: 'reported',
          },
          { id: 'e3', executorType: 'openclaw', status: 'cancelled', costUsd: null },
        ]),
      )
      const { container } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
      expect(await screen.findByRole('button', { name: 'Run history 3' })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      const runs = within(screen.getByTestId('task-runs'))
      // The team engine types every run 'openclaw'; the row names the runtime that ran.
      const estimated = runs.getByText('Codex').parentElement as HTMLElement
      expect(estimated).toHaveTextContent('Codex Succeeded · ~$0.0042 est.')
      const reported = runs.getByText('Claude Code').parentElement as HTMLElement
      expect(reported).toHaveTextContent('· $0.1200')
      expect(reported).not.toHaveTextContent('est.')
      // A run that recorded no cost shows none.
      const stopped = runs.getByText('Cancelled').parentElement as HTMLElement
      expect(stopped).toHaveTextContent(/^OpenClaw Cancelled$/)
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  // The drawer had no dialog semantics and no focus trap before it adopted the
  // shared <Modal>; screen-reader and keyboard users could Tab straight out of
  // it into the board behind the scrim.
  describe('dialog semantics', () => {
    it('is a modal dialog named after the task', async () => {
      server.use(...detailHandlers())
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

      const dialog = await screen.findByRole('dialog', { name: 'Ship it' })
      expect(dialog).toHaveAttribute('aria-modal', 'true')
    })

    it('moves focus into the drawer on open', async () => {
      server.use(...detailHandlers())
      render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

      await screen.findByText('Ship it')
      await waitFor(() =>
        expect(screen.getByTestId('task-detail-drawer').contains(document.activeElement)).toBe(
          true,
        ),
      )
    })

    it('closes on Escape', async () => {
      server.use(...detailHandlers())
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<TaskDetailDrawer taskId="t1" onClose={onClose} />)

      await screen.findByText('Ship it')
      await user.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    // The regression this drawer's Escape handler could easily reintroduce:
    // Select stops Escape in the CAPTURE phase to close its own popover, so the
    // dialog's window-BUBBLE listener must never see it. Mirrors the equivalent
    // guard for NewTaskDialog in BoardPanel.test.tsx.
    it('lets Escape dismiss the open status dropdown without closing the drawer', async () => {
      server.use(...detailHandlers())
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<TaskDetailDrawer taskId="t1" onClose={onClose} />)

      await screen.findByText('Ship it')
      await user.click(screen.getByTestId('task-status-select'))
      expect(await screen.findByRole('option', { name: 'Done' })).toBeInTheDocument()

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('option', { name: 'Done' })).toBeNull())
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByTestId('task-detail-drawer')).toBeInTheDocument()
    })

    it('has no level-A/AA a11y violations', async () => {
      server.use(...detailHandlers())
      const { container } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)

      await screen.findByText('Ship it')
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})

describe('TaskDetailDrawer: a task that needs you', () => {
  function failedHandlers(onRetry: (id: string) => void) {
    return [
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: {
            id: 't1',
            title: 'Draft the launch post',
            description: 'Keep it under 200 words and mention the new board.',
            status: 'blocked',
            teamId: 'team-1',
            assigneeAgentId: 'agent-7',
            sourceDelegationId: 'assign:n1:agent:agent-7:origin:human',
            attention: { reason: 'failed', failedRuns: 1, detail: 'provider out of credits' },
          },
          comments: [
            { body: 'Run failed: provider out of credits', authorType: 'system' },
            { body: 'Retry requested.', authorType: 'user' },
          ],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      http.post('/api/board/:id/retry', ({ params }) => {
        onRetry(params['id'] as string)
        return HttpResponse.json({ ok: true }, { status: 202 })
      }),
    ]
  }

  it('leads with why it needs you, the reason, and a Retry that reports back to the board', async () => {
    useFleetStore.setState({
      agents: [{ id: 'agent-7', name: 'Coder', teamId: 'team-1' } as AgentState],
      selectedAgentId: null,
    })
    let retried = ''
    server.use(...failedHandlers((id) => (retried = id)))
    const onChanged = vi.fn()
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} onChanged={onChanged} />)

    const banner = await screen.findByTestId('task-needs-you')
    expect(within(banner).getByText('Failed')).toBeInTheDocument()
    expect(within(banner).getByText('provider out of credits')).toBeInTheDocument()
    await userEvent.click(within(banner).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(retried).toBe('t1'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('shows the brief the person wrote and names the agent instead of its id', async () => {
    useFleetStore.setState({
      agents: [{ id: 'agent-7', name: 'Coder', teamId: 'team-1' } as AgentState],
      selectedAgentId: null,
    })
    server.use(...failedHandlers(() => {}))
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    expect(await screen.findByTestId('task-brief')).toHaveTextContent(/under 200 words/)
    expect(screen.getByText('Coder')).toBeInTheDocument()
    expect(screen.queryByText('agent-7')).toBeNull()
    // The comment log attributes each entry: Clawboo's own notes, and the person's.
    const log = screen.getByTestId('task-comments')
    expect(within(log).getByText('Clawboo')).toBeInTheDocument()
    expect(within(log).getByText('You')).toBeInTheDocument()
  })

  it('shows no needs-you banner for a task that is moving on its own', async () => {
    server.use(...detailHandlers())
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    await screen.findByText('Ship it')
    expect(screen.queryByTestId('task-needs-you')).toBeNull()
  })
})

describe('TaskDetailDrawer: reading and stepping', () => {
  /** A task with only a title, plus `extra` on the task and `ancestors` beside it. */
  function plainHandlers(
    id: string,
    title: string,
    extra: Record<string, unknown> = {},
    ancestors: unknown[] = [],
  ) {
    return [
      http.get(`/api/board/${id}`, () =>
        HttpResponse.json({
          task: { id, title, status: 'todo', ...extra },
          comments: [],
          ancestors,
        }),
      ),
      http.get(`/api/board/${id}/executions`, () => HttpResponse.json({ executions: [] })),
      http.get(`/api/board/${id}/workspace/detail`, () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    ]
  }

  it('draws no section that has nothing in it', async () => {
    server.use(...plainHandlers('t1', 'Ship it'))
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Ship it' })
    expect(screen.getByRole('button', { name: 'Properties' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument()
    for (const empty of [/^Verification/, /^Workspace/, /^Run history/, /^Comments/, /^Brief/])
      expect(screen.queryByRole('button', { name: empty })).toBeNull()
  })

  it('folds a section from its heading', async () => {
    server.use(...plainHandlers('t1', 'Ship it'))
    const user = userEvent.setup()
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    const heading = await screen.findByRole('button', { name: 'Properties' })
    expect(screen.getByText('Runtime')).toBeInTheDocument()
    await user.click(heading)
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Runtime')).toBeNull()
  })

  it('steps to the next and previous task with J and K, and with the arrows', async () => {
    server.use(...plainHandlers('t2', 'Second task'))
    const user = userEvent.setup()
    const onOpenTask = vi.fn()
    render(
      <TaskDetailDrawer
        taskId="t2"
        onClose={() => {}}
        position={{ index: 1, total: 3, prev: 't1', next: 't3' }}
        onOpenTask={onOpenTask}
      />,
    )
    await screen.findByRole('heading', { name: 'Second task' })
    expect(screen.getByTestId('task-position')).toHaveTextContent('2 of 3')

    screen.getByRole('button', { name: 'Close' }).focus()
    await user.keyboard('j')
    expect(onOpenTask).toHaveBeenLastCalledWith('t3')
    await user.keyboard('k')
    expect(onOpenTask).toHaveBeenLastCalledWith('t1')
    await user.click(screen.getByRole('button', { name: 'Next task' }))
    expect(onOpenTask).toHaveBeenLastCalledWith('t3')

    // A J typed into the status list is not a step.
    onOpenTask.mockClear()
    await user.click(screen.getByTestId('task-status-select'))
    expect((await screen.findAllByRole('option')).length).toBeGreaterThan(0)
    await user.keyboard('j')
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  it('shows the first task with no way back', async () => {
    server.use(...plainHandlers('t1', 'Ship it'))
    render(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        position={{ index: 0, total: 2, prev: null, next: 't2' }}
        onOpenTask={() => {}}
      />,
    )
    await screen.findByRole('heading', { name: 'Ship it' })
    expect(screen.getByRole('button', { name: 'Previous task' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next task' })).toBeEnabled()
  })

  it('names the parent task and the work it is part of, and opens the parent', async () => {
    server.use(
      ...plainHandlers('t3', 'Write the intro', { parentTaskId: 't2' }, [
        { id: 't1', parent_task_id: null, title: 'Launch the new board', status: 'in_progress' },
        { id: 't2', parent_task_id: 't1', title: 'Draft the launch post', status: 'in_progress' },
      ]),
    )
    const user = userEvent.setup()
    const onOpenTask = vi.fn()
    render(<TaskDetailDrawer taskId="t3" onClose={() => {}} onOpenTask={onOpenTask} />)
    const parent = await screen.findByRole('button', { name: 'Draft the launch post' })
    expect(screen.getByText('Part of').nextElementSibling).toHaveTextContent('Launch the new board')
    await user.click(parent)
    expect(onOpenTask).toHaveBeenCalledWith('t2')
  })

  it("shows the skeleton, not the last task's content, while the next one loads", async () => {
    server.use(...plainHandlers('t1', 'Ship it'))
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.get('/api/board/t2', async () => {
        await gate
        return HttpResponse.json({
          task: { id: 't2', title: 'Second task', status: 'todo' },
          comments: [],
          ancestors: [],
        })
      }),
      http.get('/api/board/t2/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t2/workspace/detail', () => HttpResponse.json({ ok: false })),
    )
    const { rerender } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Ship it' })

    rerender(<TaskDetailDrawer taskId="t2" onClose={() => {}} />)
    expect(screen.getByTestId('task-detail-loading')).toBeInTheDocument()
    expect(screen.queryByText('Ship it')).toBeNull()
    release()
    expect(await screen.findByRole('heading', { name: 'Second task' })).toBeInTheDocument()
  })
})

// An agent's text is untrusted: an image in it would load from wherever its
// address points the moment the text is shown, and the address can carry data
// out. It shows as a link to open instead.
describe('agent markdown loads no images', () => {
  const BODY =
    'Done.\n\n![the chart](https://images.example/p.png?d=secret)\n\n![](data:image/png;base64,AAAA)'

  it('draws an image in the report as a link, and fetches nothing', async () => {
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'done' },
          comments: [{ body: BODY, authorType: 'agent', authorAgentId: 'agent-7' }],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    const report = await screen.findByTestId('task-report')
    expect(report.querySelector('img')).toBeNull()
    const link = within(report).getByRole('link', { name: 'Image: the chart' })
    expect(link).toHaveAttribute('href', 'https://images.example/p.png?d=secret')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    // A data address is named, not linked.
    expect(within(report).getByText('Image')).toBeInTheDocument()
  })

  it('draws an image in an agent comment as a link', () => {
    render(<TaskComments comments={[{ body: BODY, authorType: 'agent' }]} />)
    const log = screen.getByTestId('task-comments')
    expect(log.querySelector('img')).toBeNull()
    expect(within(log).getByRole('link', { name: 'Image: the chart' })).toBeInTheDocument()
  })
})

describe('TaskDetailDrawer: review fixes', () => {
  function stubTask(id: string, task: Record<string, unknown>, getTask?: () => Promise<Response>) {
    return [
      http.get(`/api/board/${id}`, () =>
        getTask
          ? getTask()
          : HttpResponse.json({ task: { id, ...task }, comments: [], ancestors: [] }),
      ),
      http.get(`/api/board/${id}/executions`, () => HttpResponse.json({ executions: [] })),
      http.get(`/api/board/${id}/workspace/detail`, () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    ]
  }

  it('lists the findings of the latest attempt, the one the verdict and reviewer line describe', async () => {
    server.use(
      ...stubTask('t1', {
        title: 'Ship it',
        status: 'in_review',
        verification: JSON.stringify({
          status: 'pass',
          attempts: [
            {
              critic: {
                ran: true,
                findings: [{ severity: 'major', title: 'First try: missing test' }],
              },
            },
            {
              critic: {
                ran: true,
                findings: [{ severity: 'minor', title: 'Latest: rename a variable' }],
              },
            },
          ],
          debtNotes: [],
        }),
      }),
    )
    render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    const verification = await screen.findByTestId('task-verification')
    expect(within(verification).getByText(/Latest: rename a variable/)).toBeInTheDocument()
    expect(within(verification).queryByText(/First try: missing test/)).toBeNull()
  })

  it('keeps a late reply for the task it stepped away from off the one it shows', async () => {
    useFleetStore.setState({
      agents: [{ id: 'agent-7', name: 'Coder', teamId: 'team-1' } as AgentState],
      selectedAgentId: null,
    })
    const failed = {
      title: 'Draft the launch post',
      status: 'blocked',
      teamId: 'team-1',
      assigneeAgentId: 'agent-7',
      sourceDelegationId: 'assign:n1:agent:agent-7:origin:human',
      attention: { reason: 'failed', failedRuns: 1, detail: 'provider out of credits' },
    }
    // The first read of t1 answers at once; the re-read after Retry waits.
    let reads = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      ...stubTask('t1', failed, async () => {
        reads++
        if (reads > 1) await gate
        return HttpResponse.json({ task: { id: 't1', ...failed }, comments: [], ancestors: [] })
      }),
      http.post('/api/board/:id/retry', () => HttpResponse.json({ ok: true }, { status: 202 })),
      ...stubTask('t2', { title: 'Second task', status: 'todo' }),
    )
    const user = userEvent.setup()
    const { rerender } = render(<TaskDetailDrawer taskId="t1" onClose={() => {}} />)
    const banner = await screen.findByTestId('task-needs-you')
    await user.click(within(banner).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(reads).toBe(2))

    // J, before the re-read of t1 comes back.
    rerender(<TaskDetailDrawer taskId="t2" onClose={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Second task' })).toBeInTheDocument()
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByRole('heading', { name: 'Second task' })).toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-loading')).toBeNull()
  })
})
