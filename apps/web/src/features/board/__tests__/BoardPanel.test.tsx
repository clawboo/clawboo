// Durable Board panel: columns + cards from GET /api/board, and the 5s poll's
// re-fetch (driven by hand: `pollBoard()`). msw's onUnhandledRequest:'error' keeps
// the test honest about which endpoints are hit.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { server } from '../../../__vitest__/mswServer'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { BoardPanel } from '../BoardPanel'
import { pollBoard } from './boardControls'
import { resetBoardStorage } from './resetBoardStorage'

/** One team with two agents: enough for the New task dialog to have a choice. */
const ALPHA = {
  id: 'team-1',
  name: 'Alpha',
  icon: '🐙',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 2,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: true,
}
function seedTeamWithAgents(): void {
  useTeamStore.setState({ teams: [ALPHA], selectedTeamId: null })
  useFleetStore.setState({
    agents: [
      { id: 'coder', name: 'Coder', teamId: 'team-1' },
      { id: 'writer', name: 'Writer', teamId: 'team-1' },
    ] as never,
  })
}

/** Fill in the New task dialog: pick the agent (its team follows), then write the
 *  task in the one field. */
async function fillNewTask(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  title: string,
): Promise<void> {
  await user.click(within(dialog).getByLabelText('Agent'))
  await user.click(await screen.findByRole('option', { name: 'Coder' }))
  await user.type(within(dialog).getByLabelText('What should get done?'), title)
}

// dnd-kit's real pointer drag can't run in jsdom (no layout/rects), so we capture
// the REAL onDragEnd handler by passing through DndContext (keeping the real provider
// so useDraggable/useDroppable still work) and invoke it with synthetic drag events.
// The same passthrough also captures the `accessibility.announcements` object,
// so the screen-reader wiring can be asserted without a real drag (the callbacks
// are pure `(args) => string`; their exact copy is covered in
// `boardAnnouncements.test.ts`).
const dnd = vi.hoisted(() => ({
  onDragEnd: undefined as undefined | ((e: unknown) => void),
  announcements: undefined as undefined | Record<string, (args: never) => string | undefined>,
}))
vi.mock('@/lib/useVisiblePolling', async (importOriginal) =>
  (await import('./boardControls')).pollingByHand(await importOriginal()),
)

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dnd.onDragEnd = props.onDragEnd as (e: unknown) => void
      dnd.announcements = props.accessibility?.announcements as typeof dnd.announcements
      return <actual.DndContext {...props} />
    },
  }
})

beforeEach(() => {
  // teamFilter init = selectedTeamId ?? 'all' → keep it 'all' so the fetch has no ?teamId.
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  // The calendar remembers its view per browser; every test starts on the default.
  resetBoardStorage()
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

  it('keeps the header to one quiet bar: the title, the team and New task with its key', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Wire the widget', status: 'todo' }] }),
      ),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')
    const header = screen.getByTestId('board-header')
    expect(within(header).getByRole('heading', { name: 'Board' })).toBeInTheDocument()
    expect(within(header).getByLabelText('Filter by team')).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'New task' })).toHaveAttribute(
      'aria-keyshortcuts',
      'c',
    )
    // No sentence under the title, and no Refresh: the board reads itself every 5s.
    expect(screen.queryByText(/Agents create and move work here/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it("shows each card's run cost, marks an estimate, and shows none when no run recorded one", async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({
          tasks: [
            {
              id: 't1',
              title: 'Never ran',
              status: 'todo',
              runCost: { usd: null, estimated: false },
            },
            { id: 't2', title: 'Ran free', status: 'done', runCost: { usd: 0, estimated: false } },
            {
              id: 't3',
              title: 'Ran priced',
              status: 'done',
              runCost: { usd: 0.02, estimated: true },
            },
            { id: 't4', title: 'Older server', status: 'todo', costUsd: 0 },
            {
              id: 't5',
              title: 'Ran billed',
              status: 'done',
              runCost: { usd: 0.42, estimated: false },
            },
          ],
        }),
      ),
    )
    render(<BoardPanel />)
    await screen.findAllByTestId('board-card')
    const costOf = (title: string) =>
      within(
        screen.getByText(title).closest('[data-testid="board-card"]') as HTMLElement,
      ).queryByTestId('board-card-cost')

    // No run recorded a cost: the card shows nothing, rather than a $0 it never charged.
    expect(costOf('Never ran')).toBeNull()
    expect(costOf('Older server')).toBeNull()
    // A runtime that reported $0 did charge nothing, so that is shown. The card
    // shows the figure; the title and the screen reader say what kind it is.
    const shown = (title: string) => costOf(title)?.querySelector('[aria-hidden]')?.textContent
    expect(shown('Ran free')).toBe('$0.000')
    expect(costOf('Ran free')).toHaveAttribute('title', '$0.000, the cost the runtime reported')
    expect(shown('Ran priced')).toBe('~$0.02')
    expect(costOf('Ran priced')).toHaveAttribute(
      'title',
      '$0.02, estimated, not a charge the runtime reported',
    )
    expect(shown('Ran billed')).toBe('$0.42')
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
    // A Boo, not a generic icon in a disc: the drawing is the mascot's svg.
    const art = empty.querySelector('svg')
    expect(art).not.toBeNull()
    expect(art?.classList.contains('lucide')).toBe(false)
    expect(empty.querySelector('.lucide-sparkles')).toBeNull()
    // The empty state offers the same manual escape hatch as the header.
    expect(within(empty).getByRole('button', { name: /New task/i })).toBeInTheDocument()
  })

  it('creates a task FOR one agent: team, then agent, then the task', async () => {
    seedTeamWithAgents()
    let createdBody: Record<string, unknown> | null = null
    server.use(
      // Populated board → only the header "New task" button renders (no empty-state CTA).
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Existing', status: 'todo' }] }),
      ),
      http.post('/api/board', async ({ request }) => {
        createdBody = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          task: { id: 'new1', title: createdBody['title'], status: 'todo', attention: null },
        })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    await user.click(screen.getByRole('button', { name: /New task/i }))
    const dialog = await screen.findByTestId('new-task-dialog')
    // An agent is suggested, but nothing can be sent until the task is written.
    expect(within(dialog).getByRole('button', { name: /Send to Coder/i })).toBeDisabled()
    await fillNewTask(user, dialog, 'Draft the changelog')
    await user.click(within(dialog).getByRole('button', { name: /Send to Coder/i }))

    await waitFor(() => expect(createdBody).not.toBeNull())
    expect(createdBody).toEqual({
      title: 'Draft the changelog',
      teamId: 'team-1',
      assigneeAgentId: 'coder',
    })
    // The dialog closes on success.
    await waitFor(() => expect(screen.queryByTestId('new-task-dialog')).toBeNull())
  })

  it('suggests across teams, and More options lists only the chosen team’s agents', async () => {
    useTeamStore.setState({
      teams: [ALPHA, { ...ALPHA, id: 'team-2', name: 'Beta' }],
      selectedTeamId: null,
    })
    useFleetStore.setState({
      agents: [
        { id: 'coder', name: 'Coder', teamId: 'team-1' },
        { id: 'critic', name: 'Critic', teamId: 'team-2' },
      ] as never,
    })
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

    // Two teams, none filtered: the suggestion names the agent and its team.
    expect(within(dialog).getByLabelText('Agent')).toHaveTextContent('Coder, Alpha')
    await user.click(within(dialog).getByRole('button', { name: 'More options' }))
    expect(within(dialog).getByLabelText('Team')).toHaveTextContent('Alpha')
    await user.click(within(dialog).getByLabelText('Team'))
    await user.click(await screen.findByRole('option', { name: /Beta/ }))
    // A one-agent team has nothing to choose: its agent is picked for you.
    expect(within(dialog).getByLabelText('Agent')).toHaveTextContent('Critic')
    await user.click(within(dialog).getByLabelText('Agent'))
    expect(screen.queryByRole('option', { name: 'Coder' })).toBeNull()
  })

  it('moves focus into the composer (its one field) when it opens', async () => {
    seedTeamWithAgents()
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
    // useFocusTrap moves focus to the first focusable: what should get done.
    await waitFor(() =>
      expect(within(dialog).getByLabelText('What should get done?')).toHaveFocus(),
    )
  })

  it('Escape dismisses an open field dropdown without closing the composer', async () => {
    // Regression: the dialog's Escape handler must not co-fire with the Select's,
    // or dismissing a dropdown would tear down the whole form and lose typed input.
    seedTeamWithAgents()
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
    await user.type(within(dialog).getByLabelText('What should get done?'), 'Keep me')

    // Open the Agent dropdown, then press Escape to dismiss it.
    await user.click(within(dialog).getByLabelText('Agent'))
    expect(await screen.findByRole('option', { name: 'Writer' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // The menu closes, but the dialog and the typed task survive.
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Writer' })).toBeNull())
    expect(screen.getByTestId('new-task-dialog')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('What should get done?')).toHaveValue('Keep me')
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
    // A transient failure on a board that already loaded (every read goes through
    // the same `refresh()` path as the 5s poll) must NOT blank the
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
    render(<BoardPanel />)

    await screen.findByText('Persisted card') // first load succeeds
    expect(calls).toBe(1)

    fail = true
    await pollBoard()
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2)) // the failing fetch fired

    // Last good snapshot retained; no error-screen swap.
    expect(screen.getByText('Persisted card')).toBeInTheDocument()
    expect(screen.queryByTestId('board-fetch-error')).toBeNull()
  })

  it('re-fetches the board on its poll', async () => {
    let calls = 0
    let tasks = [{ id: 't1', title: 'First', status: 'todo' }]
    server.use(
      http.get('/api/board', () => {
        calls++
        return HttpResponse.json({ tasks })
      }),
    )
    render(<BoardPanel />)

    await screen.findByText('First')
    expect(calls).toBe(1)

    tasks = [...tasks, { id: 't2', title: 'Second', status: 'todo' }]
    await pollBoard()

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
    await pollBoard()
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
    await pollBoard()

    // The card follows the server to Cancelled; it is NOT stuck in Done. Cancelled
    // starts folded into a rail that keeps its count; opening it shows the card.
    await waitFor(() =>
      expect(screen.getByTestId('board-column-cancelled')).toHaveAccessibleName(
        'Cancelled, 1 task',
      ),
    )
    await user.click(screen.getByTestId('board-cancelled-rail'))
    expect(
      await within(screen.getByTestId('board-column-cancelled')).findByTestId('board-card'),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('board-column-done')).queryByTestId('board-card')).toBeNull()
  })

  it('ignores a board response that was already in flight when a drag committed', async () => {
    // Regression (#105): reads overlap by design (the 5s poll, Retry, the
    // post-create reconcile), so a GET issued BEFORE a drag commits can resolve
    // AFTER it, carrying the PRE-drag status. Applied unconditionally it snapped the
    // card back to its old column until the next poll healed it. `refresh()` is
    // sequenced against local commits, so the stale snapshot is dropped instead.
    let calls = 0
    let releaseStale: (() => void) | undefined
    let staleAnswered = false
    server.use(
      http.get('/api/board', async () => {
        calls += 1
        // Hold the 2nd read open until the test releases it. Every read answers with
        // the pre-drag snapshot, so the released one is genuinely stale.
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve
          })
          staleAnswered = true
        }
        return HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }] })
      }),
      http.patch('/api/board/t1', () =>
        HttpResponse.json({ ok: true, task: { id: 't1', status: 'done' } }),
      ),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    // Start the slow read, then commit the drag while it is still in flight.
    await pollBoard()
    await waitFor(() => expect(calls).toBe(2))
    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'done' } }) // in_progress → done (legal)
    })
    await waitFor(() =>
      expect(
        within(screen.getByTestId('board-column-done')).queryByTestId('board-card'),
      ).not.toBeNull(),
    )

    // The stale read now lands, reporting the task still In progress.
    releaseStale?.()
    await waitFor(() => expect(staleAnswered).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0)) // flush fetch → json → setState
    })

    // The committed move survives — no snap-back to In progress.
    expect(
      within(screen.getByTestId('board-column-done')).getByTestId('board-card'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('board-column-in_progress')).queryByTestId('board-card'),
    ).toBeNull()
  })

  it('ignores a board response that was already in flight when a task was created', async () => {
    seedTeamWithAgents()
    // Regression (#105), the create half: the composer prepends the new task
    // optimistically and kicks a reconcile read. A read issued BEFORE the POST
    // landed answers WITHOUT the new task, so applying it blanked the just-created
    // card until the next poll. Only the newest read may write to the board.
    const EXISTING = [{ id: 't1', title: 'Existing', status: 'todo' }]
    let calls = 0
    let releaseStale: (() => void) | undefined
    let staleAnswered = false
    let created = false
    server.use(
      http.get('/api/board', async () => {
        calls += 1
        // Read 2 is held open and answers with the pre-create snapshot; read 3 is
        // handleCreated's reconcile, which sees the new task.
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve
          })
          staleAnswered = true
          return HttpResponse.json({ tasks: EXISTING })
        }
        return HttpResponse.json({
          tasks: created
            ? [...EXISTING, { id: 'new1', title: 'Draft the changelog', status: 'todo' }]
            : EXISTING,
        })
      }),
      http.post('/api/board', async ({ request }) => {
        const body = (await request.json()) as { title: string; status?: string }
        created = true
        return HttpResponse.json({
          task: { id: 'new1', title: body.title, status: body.status ?? 'todo' },
        })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    // Start the slow read, then create a task while it is still in flight.
    await pollBoard()
    await waitFor(() => expect(calls).toBe(2))

    await user.click(screen.getByRole('button', { name: /New task/i }))
    const dialog = await screen.findByTestId('new-task-dialog')
    await fillNewTask(user, dialog, 'Draft the changelog')
    await user.click(within(dialog).getByRole('button', { name: /Send to Coder/i }))
    expect(await screen.findByText('Draft the changelog')).toBeInTheDocument()

    // The stale read now lands, reporting a board without the new task.
    releaseStale?.()
    await waitFor(() => expect(staleAnswered).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0)) // flush fetch → json → setState
    })

    // The created card survives — it isn't blanked by the pre-create snapshot.
    expect(screen.getByText('Draft the changelog')).toBeInTheDocument()
  })

  it('discards an in-flight response for the previous team filter', async () => {
    // Same ordering hazard on the filter path: switching teams re-enters the loading
    // state, but a read for the PREVIOUS filter can still resolve afterwards. Applied
    // it would both write the wrong team's tasks and dismiss the skeleton over them.
    useTeamStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Alpha',
          icon: '🐙',
          color: '#e94560',
          colorCollectionId: null,
          templateId: null,
          agentCount: 1,
          leaderAgentId: null,
          isArchived: false,
          serverOrchestrated: false,
        },
      ],
      selectedTeamId: null, // teamFilter starts at 'all' → the first read has no ?teamId
    })
    let releaseStale: (() => void) | undefined
    let staleAnswered = false
    server.use(
      http.get('/api/board', async ({ request }) => {
        const teamId = new URL(request.url).searchParams.get('teamId')
        if (teamId === null) {
          // The all-teams read from mount, held open past the filter switch.
          await new Promise<void>((resolve) => {
            releaseStale = resolve
          })
          staleAnswered = true
          return HttpResponse.json({
            tasks: [{ id: 'a1', title: 'All-teams task', status: 'todo' }],
          })
        }
        return HttpResponse.json({ tasks: [{ id: 'b1', title: 'Alpha task', status: 'todo' }] })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    // The first read hasn't resolved, so the board is still skeletons.
    expect(screen.getByTestId('board-skeleton')).toBeInTheDocument()

    // Switch to the team filter; its read resolves normally.
    await user.click(screen.getByLabelText('Filter by team'))
    await user.click(await screen.findByRole('option', { name: /Alpha/ }))
    expect(await screen.findByText('Alpha task')).toBeInTheDocument()

    // The all-teams read now lands, after the filter already moved on.
    releaseStale?.()
    await waitFor(() => expect(staleAnswered).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0)) // flush fetch → json → setState
    })

    expect(screen.getByText('Alpha task')).toBeInTheDocument()
    expect(screen.queryByText('All-teams task')).toBeNull()
  })

  it('confirms before a drag that unassigns a running agent (→ To do)', async () => {
    let patched: { status?: string } | null = null
    // An open task's card names its agent's runtime, read from the fleet.
    useFleetStore.setState({
      agents: [{ id: 'agent-7', name: 'Coder', runtime: 'claude-code' } as never],
    })
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({
          tasks: [
            {
              id: 't1',
              title: 'Ship it',
              status: 'in_progress',
              assigneeAgentId: 'agent-7',
              assigneeRuntime: 'claude-code',
              verification: JSON.stringify({ status: 'fail' }),
              // Bound to its agent, so To do is where it waits to be picked up again.
              sourceDelegationId: 'd1:agent:agent-7:reflectTo:lead',
            },
          ],
        }),
      ),
      http.patch('/api/board/t1', async ({ request }) => {
        patched = (await request.json()) as { status: string }
        return HttpResponse.json({ ok: true, task: { id: 't1', status: patched.status } })
      }),
    )
    const user = userEvent.setup()
    // The card draws its agent's Boo, which reads the theme.
    render(
      <ThemeProvider>
        <BoardPanel />
        <ConfirmDialog />
      </ThemeProvider>,
    )
    // Sanity: before the move the card carries its agent and its failed check.
    const card = await screen.findByTestId('board-card')
    expect(within(card).getByText('Assigned to Coder')).toBeInTheDocument()
    expect(within(card).getByTitle('Verification failed')).toBeInTheDocument()

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'todo' } }) // in_progress → todo (release)
    })

    // The shared confirm gate intercepts the drag — nothing is sent until confirmed.
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(patched).toBeNull()
    await user.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => expect(patched).toEqual({ status: 'todo' }))

    // The commit mirrors the server's →todo release: it also clears the assignee and the
    // verdict, so the card in To do no longer shows the misleading failed check; the
    // reflection is complete, not just the column. (Deleting the →todo branch in
    // commitStatus fails this.) It keeps the agent it is bound to.
    const todoCard = () => within(screen.getByTestId('board-column-todo')).getByTestId('board-card')
    await waitFor(() => expect(within(todoCard()).queryByTitle('Verification failed')).toBeNull())
    expect(within(todoCard()).getByText('Assigned to Coder')).toBeInTheDocument()
  })

  it('offers "Complete anyway" when a drag to Done hits the verification gate', async () => {
    // The shared useStatusMutation means the override the drawer got in #97 also
    // works from the drag path — a drag to Done blocked by the gate offers the override.
    const bodies: Array<{ status?: string; humanOverride?: boolean }> = []
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }] }),
      ),
      http.patch('/api/board/t1', async ({ request }) => {
        const body = (await request.json()) as { status: string; humanOverride?: boolean }
        bodies.push(body)
        if (body.humanOverride) {
          return HttpResponse.json({ ok: true, task: { id: 't1', status: 'done' } })
        }
        return HttpResponse.json({ ok: false, error: 'verification_required' }, { status: 409 })
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
      dnd.onDragEnd?.({ active: { id: 't1' }, over: { id: 'done' } }) // in_progress → done (gated)
    })

    const dialog = await screen.findByTestId('confirm-dialog')
    await user.click(within(dialog).getByTestId('confirm-ok'))

    // The gated attempt, then the audited override retry — same flow as the drawer.
    await waitFor(() =>
      expect(bodies).toEqual([{ status: 'done' }, { status: 'done', humanOverride: true }]),
    )
    expect(
      within(screen.getByTestId('board-column-done')).getByTestId('board-card'),
    ).toBeInTheDocument()
  })

  // dnd-kit's `defaultAnnouncements` read raw ids at a screen-reader user
  // ("Picked up draggable item 9f3c8a1e-…"). This asserts the WIRING — that the
  // custom announcements reach DndContext and that the grip carries the payload
  // they read. The copy itself is covered in boardAnnouncements.test.ts.
  it('announces drags by task title and column label, not by raw ids', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }] }),
      ),
    )
    render(<BoardPanel />)
    await screen.findByTestId('board-card')

    // The grip handle is dnd-kit's drag activator; it carries the instructions
    // a keyboard user hears before pickup.
    const grip = screen.getByRole('button', { name: /Drag to move “Ship it”/ })
    expect(grip).toHaveAttribute('aria-describedby')

    const a = dnd.announcements
    expect(a).toBeDefined()
    const active = { id: 't1', data: { current: { fromStatus: 'in_progress', title: 'Ship it' } } }

    expect(a?.onDragStart?.({ active } as never)).toBe('Picked up “Ship it” from In progress.')
    const dropped = a?.onDragEnd?.({ active, over: { id: 'done' } } as never)
    expect(dropped).toContain('Ship it')
    expect(dropped).toContain('Done')
    expect(dropped).not.toMatch(/t1|in_progress/)
  })

  it('moves a card to its new column immediately when a status change commits in the drawer (#98)', async () => {
    // A drawer status commit patches BoardPanel.tasks via onStatusCommitted, so the card
    // jumps columns at once instead of waiting up to ~5s for the reconciliation poll.
    // Server truth advances on the PATCH (a real backend would), so the next poll —
    // run here by hand through the same refresh() path, keeps the card in
    // its new column with no flicker and no duplicate.
    let board = [{ id: 't1', title: 'Ship it', status: 'todo' }]
    let boardGets = 0
    server.use(
      http.get('/api/board', () => {
        boardGets++
        return HttpResponse.json({ tasks: board })
      }),
      // The drawer's on-mount fetches; the detail reflects the current server status.
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: board[0]!.status },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      http.patch('/api/board/t1', async ({ request }) => {
        const body = (await request.json()) as { status: string }
        board = [{ id: 't1', title: 'Ship it', status: body.status }] // the server advances
        return HttpResponse.json({ ok: true, task: { id: 't1', status: body.status } })
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)

    // The card starts in To do.
    await screen.findByTestId('board-card')
    expect(
      within(screen.getByTestId('board-column-todo')).getByTestId('board-card'),
    ).toBeInTheDocument()

    // Open the drawer and pick the Backlog target.
    await user.click(screen.getByTestId('board-card'))
    await screen.findByTestId('task-detail-drawer')
    await user.click(screen.getByTestId('task-status-select'))
    const option = await screen.findByRole('option', { name: 'Backlog' })

    // Snapshot the board-list fetch count right before the commit. Nothing in the window
    // below fetches the list, so the only thing that can move the card is the optimistic
    // onStatusCommitted patch — a poll/refetch would bump this count and fail the assert.
    // (Captured here, not before opening the drawer, to keep the window tiny so the real
    // 5s poll can't race it.)
    const getsBeforeMove = boardGets
    await user.click(option)

    // The card is in the Backlog column right away: optimistic, not poll-driven.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('board-column-backlog')).getByTestId('board-card'),
      ).toBeInTheDocument(),
    )
    expect(within(screen.getByTestId('board-column-todo')).queryByTestId('board-card')).toBeNull()
    expect(boardGets).toBe(getsBeforeMove) // moved without waiting for the poll
    expect(screen.getAllByTestId('board-card')).toHaveLength(1) // no duplicate

    // Close the drawer; the board keeps the card in its new column.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('task-detail-drawer')).toBeNull())

    // Focus comes back to the card, not <body>. Moving columns destroyed the exact node
    // the drawer was opened from, so the return only works because the card carries
    // `data-focus-restore-id` for useFocusTrap to re-find it. Without it a keyboard user
    // closes the drawer and the next Tab restarts at the top of the document.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('board-column-backlog')).getByTestId('board-card'),
      ).toHaveFocus(),
    )

    // The next poll reconciles against the advanced
    // server and keeps the card put — no flicker back to To do, still exactly one card.
    await pollBoard()
    await waitFor(() => expect(boardGets).toBeGreaterThan(getsBeforeMove))
    expect(
      within(screen.getByTestId('board-column-backlog')).getByTestId('board-card'),
    ).toBeInTheDocument()
    expect(screen.getAllByTestId('board-card')).toHaveLength(1)
  })

  it('leaves the card in its column when a drawer status change is rejected (#98)', async () => {
    // Board analog of the drag-rollback test: onStatusCommitted is wired to StatusSelect's
    // success-only onChange, so a 500'd PATCH never calls it — the card must not move, and
    // no refetch is triggered. Guards against a regression that moves the callback outside
    // the success gate.
    let boardGets = 0
    let patchCalls = 0
    server.use(
      http.get('/api/board', () => {
        boardGets++
        return HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'todo' }] })
      }),
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'todo' },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
      http.patch('/api/board/t1', () => {
        patchCalls++
        return new HttpResponse(null, { status: 500 }) // legal move todo→backlog, refused
      }),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)

    await screen.findByTestId('board-card')
    await user.click(screen.getByTestId('board-card'))
    await screen.findByTestId('task-detail-drawer')
    await user.click(screen.getByTestId('task-status-select'))
    const option = await screen.findByRole('option', { name: 'Backlog' })
    const getsBeforeMove = boardGets
    await user.click(option)

    // The failure surfaced as an error toast — the rejection path ran to completion.
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true),
    )
    // ...driven by a REAL server rejection: the PATCH fired exactly once. This is what
    // distinguishes a 500 from a client-side illegal-transition refusal that never sends a
    // request: todo→backlog is legal, so the request goes out and comes back refused.
    expect(patchCalls).toBe(1)
    // ...and the board card never moved: still in To do, exactly one card, and no refetch.
    expect(
      within(screen.getByTestId('board-column-todo')).getByTestId('board-card'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('board-column-backlog')).queryByTestId('board-card'),
    ).toBeNull()
    expect(screen.getAllByTestId('board-card')).toHaveLength(1)
    expect(boardGets).toBe(getsBeforeMove)
  })
  describe('columns: Needs you replaces Needs approval, In review and Blocked', () => {
    const renderThemed = () =>
      render(
        <ThemeProvider>
          <BoardPanel />
        </ThemeProvider>,
      )

    it('routes a failed task into Needs you with its badge; there is no Blocked column', async () => {
      server.use(
        http.get('/api/board', () =>
          HttpResponse.json({
            tasks: [
              {
                id: 't1',
                title: 'Draft the launch post',
                status: 'blocked',
                teamId: 'team-1',
                sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
                attention: { reason: 'failed', failedRuns: 1, detail: 'boom' },
              },
            ],
          }),
        ),
      )
      renderThemed()
      const card = await screen.findByTestId('needs-you-task')
      expect(within(screen.getByTestId('board-column-needs-you')).getByText('Failed')).toBeTruthy()
      expect(card).toHaveTextContent('Draft the launch post')
      expect(screen.queryByTestId('board-column-blocked')).toBeNull()
    })

    it('a stopped task leaves To do for Needs you, instead of looking queued forever', async () => {
      server.use(
        http.get('/api/board', () =>
          HttpResponse.json({
            tasks: [
              {
                id: 't1',
                title: 'Stopped work',
                status: 'todo',
                attention: { reason: 'stopped', failedRuns: 0 },
              },
              { id: 't2', title: 'Queued work', status: 'todo', attention: null },
            ],
          }),
        ),
      )
      renderThemed()
      await screen.findByTestId('needs-you-task')
      const todo = screen.getByTestId('board-column-todo')
      expect(within(todo).getByText('Queued work')).toBeInTheDocument()
      expect(within(todo).queryByText('Stopped work')).toBeNull()
    })

    it('an in-review task sits in In progress, badged Verifying; there is no In review column', async () => {
      server.use(
        http.get('/api/board', () =>
          HttpResponse.json({ tasks: [{ id: 't1', title: 'Being checked', status: 'in_review' }] }),
        ),
      )
      renderThemed()
      await screen.findByTestId('board-card')
      const inProgress = screen.getByTestId('board-column-in_progress')
      expect(within(inProgress).getByText('Being checked')).toBeInTheDocument()
      expect(within(inProgress).getByText('Verifying')).toBeInTheDocument()
      expect(screen.queryByTestId('board-column-in_review')).toBeNull()
    })

    it('Needs you stays expanded when nothing needs you', async () => {
      server.use(
        http.get('/api/board', () =>
          HttpResponse.json({ tasks: [{ id: 't1', title: 'Fine', status: 'todo' }] }),
        ),
      )
      renderThemed()
      await screen.findByTestId('board-card')
      expect(screen.getByTestId('needs-you-empty')).toBeInTheDocument()
    })
  })

  it('steps the drawer down and up its column with J and K, in the order the board draws it', async () => {
    resetBoardStorage({ view: 'all' })
    const HOUR = 60 * 60 * 1000
    const tasks = [
      { id: 'a', title: 'Newest', status: 'todo', createdAt: Date.now() - HOUR },
      { id: 'b', title: 'Middle', status: 'todo', createdAt: Date.now() - 2 * HOUR },
      { id: 'c', title: 'Oldest', status: 'todo', createdAt: Date.now() - 3 * HOUR },
      { id: 'd', title: 'Elsewhere', status: 'backlog', createdAt: Date.now() - HOUR },
    ]
    server.use(
      http.get('/api/board', () => HttpResponse.json({ tasks })),
      http.get('/api/board/:id', ({ params }) =>
        HttpResponse.json({
          task: tasks.find((t) => t.id === params['id']),
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/:id/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/:id/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await user.click((await screen.findByText('Middle')).closest('button')!)
    const drawer = await screen.findByTestId('task-detail-drawer')
    await within(drawer).findByRole('heading', { name: 'Middle' })
    expect(within(drawer).getByTestId('task-position')).toHaveTextContent('2 of 3')

    await user.keyboard('j')
    expect(await within(drawer).findByRole('heading', { name: 'Oldest' })).toBeInTheDocument()
    expect(within(drawer).getByTestId('task-position')).toHaveTextContent('3 of 3')
    expect(within(drawer).getByRole('button', { name: 'Next task' })).toBeDisabled()

    await user.keyboard('kk')
    expect(await within(drawer).findByRole('heading', { name: 'Newest' })).toBeInTheDocument()
    expect(within(drawer).getByTestId('task-position')).toHaveTextContent('1 of 3')
  })

  it('steps only through the cards the board draws, not a folded Earlier row', async () => {
    // Week view. Backlog work from before the week sits in Earlier, folded
    // because it is only parked work; J and K pass over it.
    const HOUR = 60 * 60 * 1000
    const tasks = [
      {
        id: 'old',
        title: 'Parked long ago',
        status: 'backlog',
        createdAt: Date.now() - 10 * 24 * HOUR,
      },
      {
        id: 'a',
        title: 'Parked this morning',
        status: 'backlog',
        createdAt: Date.now() - 2 * HOUR,
      },
      { id: 'b', title: 'Parked an hour ago', status: 'backlog', createdAt: Date.now() - HOUR },
    ]
    server.use(
      http.get('/api/board', () => HttpResponse.json({ tasks })),
      http.get('/api/board/:id', ({ params }) =>
        HttpResponse.json({
          task: tasks.find((t) => t.id === params['id']),
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/:id/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/:id/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    const user = userEvent.setup()
    render(<BoardPanel />)
    await user.click((await screen.findByText('Parked this morning')).closest('button')!)
    const drawer = await screen.findByTestId('task-detail-drawer')
    await within(drawer).findByRole('heading', { name: 'Parked this morning' })
    expect(within(drawer).getByTestId('task-position')).toHaveTextContent('1 of 2')
    expect(within(drawer).getByRole('button', { name: 'Previous task' })).toBeDisabled()
  })

  it('opens the task a chat card asked for ("Open on board")', async () => {
    server.use(
      http.get('/api/board', () =>
        HttpResponse.json({ tasks: [{ id: 't1', title: 'Ship it', status: 'in_progress' }] }),
      ),
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'in_progress' },
          comments: [],
          ancestors: [],
        }),
      ),
      http.get('/api/board/t1/executions', () => HttpResponse.json({ executions: [] })),
      http.get('/api/board/t1/workspace/detail', () => HttpResponse.json({ ok: false })),
      http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    )
    useViewStore.getState().openBoardTask('t1', null)
    render(<BoardPanel />)
    expect(await screen.findByTestId('task-detail-drawer')).toBeInTheDocument()
    // The request is consumed: closing and re-rendering does not re-open it.
    expect(useViewStore.getState().boardFocus).toBeNull()
  })
})
