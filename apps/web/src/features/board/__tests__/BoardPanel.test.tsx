// Durable Board panel: columns + cards from GET /api/board, and the Refresh
// re-fetch. msw's onUnhandledRequest:'error' keeps the test honest about which
// endpoints are hit.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { BoardPanel } from '../BoardPanel'

// dnd-kit's real pointer drag can't run in jsdom (no layout/rects), so we capture
// the REAL onDragEnd handler by passing through DndContext (keeping the real provider
// so useDraggable/useDroppable still work) and invoke it with synthetic drag events.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as undefined | ((e: unknown) => void) }))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dnd.onDragEnd = props.onDragEnd as (e: unknown) => void
      return <actual.DndContext {...props} />
    },
  }
})

beforeEach(() => {
  // teamFilter init = selectedTeamId ?? 'all' → keep it 'all' so the fetch has no ?teamId.
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] }) // isolate toast assertions across tests
})
afterEach(() => cleanup())

describe('BoardPanel', () => {
  it('renders columns + cards from GET /api/board', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Wire the widget', status: 'todo' }] }),
      ),
    )
    render(<BoardPanel />)

    const card = await screen.findByTestId('board-card')
    expect(card).toHaveTextContent('Wire the widget')
    expect(
      within(screen.getByTestId('board-column-todo')).getByTestId('board-card'),
    ).toBeInTheDocument()
  })

  it('explains the agent-driven model so the read-only board is self-explanatory', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Wire the widget', status: 'todo' }] }),
      ),
    )
    render(<BoardPanel />)
    const hint = await screen.findByTestId('board-agent-hint')
    expect(hint).toHaveTextContent(/AI agents continuously create and move work/i)
    expect(hint).toHaveTextContent(/manage tasks manually/i)
  })

  it('offers a New task button in the header', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Wire the widget', status: 'todo' }] }),
      ),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')
    expect(screen.getByRole('button', { name: /New task/i })).toBeInTheDocument()
  })

  it('shows a branded empty state with a manual CTA when the board is empty', async () => {
    server.use(http.get('/api/board', () => HttpResponse.json({ tasks: [] })))
    render(<BoardPanel />)
    const empty = await screen.findByTestId('board-empty')
    expect(within(empty).getByText('No tasks yet')).toBeInTheDocument()
    // The empty state offers the same manual escape hatch as the header.
    expect(within(empty).getByRole('button', { name: /New task/i })).toBeInTheDocument()
  })

  it('creates a task through the composer and posts it to /api/board', async () => {
    let createdBody: { title?: string; status?: string } | null = null
    server.use(
      // Populated board → only the header "New task" button renders (no empty-state CTA).
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Existing', status: 'todo' }] }),
      ),
      http.post('/api/board', async ({ request }) => {
        createdBody = (await request.json()) as { title: string; status?: string }
        return HttpResponse.json({
          task: { id: 'new1', title: createdBody.title, status: createdBody.status ?? 'todo' },
        })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    await user.click(screen.getByRole('button', { name: /New task/i }))
    const dialog = await screen.findByTestId('new-task-dialog')
    await user.type(within(dialog).getByLabelText('Title'), 'Draft the changelog')
    await user.click(within(dialog).getByRole('button', { name: /Create task/i }))

    await waitFor(() => expect(createdBody).not.toBeNull())
    expect(createdBody).toMatchObject({ title: 'Draft the changelog', status: 'todo' })
    // The dialog closes on success.
    await waitFor(() => expect(screen.queryByTestId('new-task-dialog')).toBeNull())
  })

  it('moves focus into the composer (title field) when it opens', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Existing', status: 'todo' }] }),
      ),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    await user.click(screen.getByRole('button', { name: /New task/i }))
    const dialog = await screen.findByTestId('new-task-dialog')
    // useFocusTrap moves focus to the first focusable — the title input.
    await waitFor(() => expect(within(dialog).getByLabelText('Title')).toHaveFocus())
  })

  it('Escape dismisses an open field dropdown without closing the composer', async () => {
    // Regression: the dialog's Escape handler must not co-fire with the Select's,
    // or dismissing a dropdown would tear down the whole form and lose typed input.
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Existing', status: 'todo' }] }),
      ),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    await user.click(screen.getByRole('button', { name: /New task/i }))
    const dialog = await screen.findByTestId('new-task-dialog')
    await user.type(within(dialog).getByLabelText('Title'), 'Keep me')

    // Open the Status dropdown, then press Escape to dismiss it.
    await user.click(within(dialog).getByLabelText('Initial status'))
    expect(await screen.findByRole('option', { name: 'Backlog' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // The menu closes, but the dialog — and the typed title — survive.
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Backlog' })).toBeNull())
    expect(screen.getByTestId('new-task-dialog')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Keep me')
  })

  it('shows a skeleton on first mount, before the board fetch resolves', () => {
    server.use(http.get('/api/board', () => HttpResponse.json({ tasks: [] })))
    render(<BoardPanel />)
    // loaded=false on the synchronous first render → skeleton, not a flash of an
    // empty board (the fetch resolves a microtask later).
    expect(screen.getByTestId('board-skeleton')).toBeInTheDocument()
  })

  it('shows an error + retry when the board fetch fails (not a silent empty board)', async () => {
    server.use(http.get('/api/board', () => new HttpResponse(null, { status: 500 })))
    render(<BoardPanel />)
    expect(await screen.findByTestId('board-fetch-error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('renders an off-list status in a catch-all Other column (no silent drop)', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't9', title: 'Weird one', status: 'archived' }] }),
      ),
    )
    render(<BoardPanel />)
    expect(await screen.findByText('Weird one')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('board-column-__other__')).getByText('Weird one'),
    ).toBeInTheDocument()
  })

  it('keeps the last good board when a refresh fails after a successful load', async () => {
    // A transient failure on a board that already loaded (the 5s poll and the
    // Refresh button share the same `refresh()` path) must NOT blank the
    // populated columns to the error screen — it keeps the last good snapshot.
    let calls = 0
    let fail = false
    server.use(
      http.get('/api/board', () => {
        calls++
        return fail
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({ tasks: [{ id: 't1', title: 'Persisted card', status: 'todo' }] })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)

    await screen.findByText('Persisted card') // first load succeeds
    expect(calls).toBe(1)

    fail = true
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2)) // the failing fetch fired

    // Last good snapshot retained; no error-screen swap.
    expect(screen.getByText('Persisted card')).toBeInTheDocument()
    expect(screen.queryByTestId('board-fetch-error')).toBeNull()
  })

  it('re-fetches the board on Refresh', async () => {
    let calls = 0
    let tasks = [{ id: 't1', title: 'First', status: 'todo' }]
    server.use(
      http.get('/api/board', () => {
        calls++
        return HttpResponse.json({ tasks })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)

    await screen.findByText('First')
    expect(calls).toBe(1)

    tasks = [...tasks, { id: 't2', title: 'Second', status: 'todo' }]
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByText('Second')).toBeInTheDocument()
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('drag-moves a card to a legal column and PATCHes the status', async () => {
    let patched: { status?: string } | null = null
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }] }),
      ),
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: patched.status } })
      }),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    // Simulate dropping the in_progress card onto the Done column (a legal move).
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'done' } })
    })

    await waitFor(() => expect(patched).toEqual({ status: 'done' }))
    // Optimistic move: the card now sits in the Done column.
    expect(
      within(screen.getByTestId('board-column-done')).getByTestId('board-card'),
    ).toBeInTheDocument()
  })

  it('rolls back an optimistic drag when the server rejects the move (500)', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }] }),
      ),
      // A legal move (in_progress → done) that the server refuses.
      http.patch('/api/board/t1', () => new HttpResponse(null, { status: 500 })),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')
    // Sanity: it starts in the In progress column.
    expect(
      within(screen.getByTestId('board-column-in_progress')).getByTestId('board-card'),
    ).toBeInTheDocument()

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'done' } })
    })

    // The optimistic override is rolled back: the card returns to In progress and is
    // NOT left stuck in Done (no lingering override).
    await waitFor(() =>
      expect(
        within(screen.getByTestId('board-column-in_progress')).queryByTestId('board-card'),
      ).not.toBeNull(),
    )
    expect(within(screen.getByTestId('board-column-done')).queryByTestId('board-card')).toBeNull()
    // A subsequent poll doesn't resurrect the move either (override truly cleared).
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(
      within(screen.getByTestId('board-column-in_progress')).getByTestId('board-card'),
    ).toBeInTheDocument()
  })

  it('rejects an illegal drag client-side without a PATCH', async () => {
    let patchCalled = false
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'todo' }] }),
      ),
      http.patch('/api/board/t1', () => {
        patchCalled = true
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    // todo → done is not a legal transition; the shared mutation must reject it
    // client-side (no wasted PATCH), matching the drawer editor.
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'done' } })
    })

    expect(patchCalled).toBe(false)
    // The card stays in the To do column.
    expect(
      within(screen.getByTestId('board-column-todo')).getByTestId('board-card'),
    ).toBeInTheDocument()
    // And the rejection actually ran (not a silent no-op): an error toast was raised.
    await waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /can’t move/i.test(t.message)),
      ).toBe(true),
    )
  })

  it('does not stay pinned when the server advances the task past the drag target', async () => {
    // Regression: a committed drag must not leave the card stuck in its target column
    // when a concurrent agent moves it further before the next poll (drag → To do, then
    // an agent re-claims it → In progress). The move commits, then the poll wins.
    let board = [{ id: 't1', title: 'Ship it', status: 'in_progress' }]
    server.use(
      http.get('/api/board', () => HttpResponse.json({ tasks: board })),
      http.patch('/api/board/t1', () =>
        HttpResponse.json({ ok: true, task: { id: 't1', status: 'done' } }),
      ),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'done' } }) // in_progress → done (legal)
    })
    await waitFor(() =>
      expect(
        within(screen.getByTestId('board-column-done')).queryByTestId('board-card'),
      ).not.toBeNull(),
    )

    // A poll now reports the task advanced past 'done' to 'cancelled'.
    board = [{ id: 't1', title: 'Ship it', status: 'cancelled' }]
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    // The card follows the server to Cancelled — it is NOT stuck in Done.
    expect(
      await within(screen.getByTestId('board-column-cancelled')).findByTestId('board-card'),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('board-column-done')).queryByTestId('board-card')).toBeNull()
  })

  it('confirms before a drag that unassigns a running agent (→ To do)', async () => {
    let patched: { status?: string } | null = null
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({
          tasks: [
            { id: 't1', title: 'Ship it', status: 'in_progress', assigneeAgentId: 'agent-7' },
          ],
        }),
      ),
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: patched.status } })
      }),
    )
    const user = userEvent.setup()
    render(
      <>
        <BoardPanel />
        <ConfirmDialog />
      </>,
    )
    await screen.findByTestId('board-card')

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'todo' } }) // in_progress → todo (release)
    })

    // The shared confirm gate intercepts the drag — nothing is sent until confirmed.
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(patched).toBeNull()
    await user.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => expect(patched).toEqual({ status: 'todo' }))
  })
})
