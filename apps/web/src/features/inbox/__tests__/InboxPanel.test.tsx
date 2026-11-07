// The Inbox: Needs you, Unread and All, over the read state on the server. Opening a
// task clears it, and the board's own drawer does the opening, so it reads the same
// from wherever the task is opened.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useAlertSignal } from '@/features/alerts/alertSignal'
import { resetBoardPerson } from '@/features/board/useBoardPerson'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { InboxPanel } from '../InboxPanel'
import { resetInboxStore, useInboxStore } from '../inboxStore'

const T = { timeout: 4000 }

type Row = Record<string, unknown> & { id: string; title: string; status: string }

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  title: `Task ${id}`,
  status: 'todo',
  teamId: 'team-a',
  sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:lead',
  updatedAt: Date.now() - 60_000,
  unread: false,
  activity: { seq: 1, kind: 'status', at: Date.now() - 60_000 },
  ...over,
})

let rows: Row[] = []
let reads: Array<{ taskId: string; through: number }> = []
let allReads: Array<{ through: number; teamId?: string }> = []
let boardReads = 0

beforeEach(() => {
  rows = []
  reads = []
  allReads = []
  boardReads = 0
  resetInboxStore()
  resetBoardPerson()
  useAlertSignal.setState({ seq: 0, inbox: 0, inboxEvent: 0, boardActivity: 0, boardReads: 0 })
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useFleetStore.setState({ agents: [] })
  useToastStore.setState({ toasts: [] })
  useTeamStore.setState({
    teams: [{ id: 'team-a', name: 'Research', icon: 'r' }] as never,
    selectedTeamId: null,
  })
  server.use(
    http.get('/api/board', () => {
      boardReads += 1
      return HttpResponse.json({ tasks: rows })
    }),
    http.get('/api/tools/approvals', () => HttpResponse.json({ ok: true, approvals: [] })),
    http.get('/api/access/identity', () =>
      HttpResponse.json({ you: { id: 'local', name: 'You', role: null } }),
    ),
    http.get('/api/board/:taskId', ({ params }) => {
      const task = rows.find((t) => t.id === params['taskId'])
      return task
        ? HttpResponse.json({ task, comments: [], ancestors: [] })
        : new HttpResponse(null, { status: 404 })
    }),
    http.get('/api/board/:taskId/executions', () => HttpResponse.json({ executions: [] })),
    http.get('/api/board/:taskId/workspace/detail', () => new HttpResponse(null, { status: 404 })),
    http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [] })),
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    http.post('/api/board/inbox/read', async ({ request }) => {
      allReads.push((await request.json()) as { through: number; teamId?: string })
      return HttpResponse.json({ ok: true })
    }),
    http.post('/api/board/:taskId/read', async ({ params, request }) => {
      const body = (await request.json()) as { through: number }
      reads.push({ taskId: String(params['taskId']), through: body.through })
      return HttpResponse.json({ ok: true, unread: false })
    }),
  )
})
afterEach(() => cleanup())

function mount() {
  return render(
    <ThemeProvider>
      <InboxPanel />
    </ThemeProvider>,
  )
}

const tab = (name: RegExp): HTMLElement => screen.getByRole('tab', { name })
const listed = (): string[] =>
  screen.queryAllByTestId('inbox-row').map((el) => el.getAttribute('data-task-id') ?? '')

describe('InboxPanel', () => {
  it('offers Needs you, Unread, Mine and All, each with what it holds', async () => {
    rows = [
      row('stuck', { status: 'blocked', attention: { reason: 'failed', failedRuns: 1 } }),
      row('new', { unread: true, activity: { seq: 5, kind: 'comment', at: Date.now() } }),
      row('old'),
      row('yours', { assigneePersonId: 'local' }),
    ]
    mount()
    await waitFor(() => expect(tab(/Needs you/)).toHaveTextContent('1'), T)
    expect(tab(/Unread/)).toHaveTextContent('1')
    expect(tab(/Mine/)).toHaveTextContent('1')
    expect(tab(/All/)).toHaveTextContent('4')
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual([
      'Needs you',
      'Unread',
      'Mine',
      'All',
    ])
  })

  it('Mine lists what is assigned to you, the same tasks as the Board filter', async () => {
    server.use(
      http.get('/api/access/identity', () =>
        HttpResponse.json({ you: { id: 'p-priya', name: 'Priya', role: null } }),
      ),
    )
    rows = [
      row('hers', { assigneePersonId: 'p-priya', activity: { seq: 3, kind: 'status', at: 3 } }),
      row('anyones', { assigneePersonId: 'local', activity: { seq: 9, kind: 'status', at: 9 } }),
      row('theirs', { assigneePersonId: 'p-sam', activity: { seq: 7, kind: 'status', at: 7 } }),
      row('agents', { activity: { seq: 8, kind: 'status', at: 8 } }),
    ]
    mount()
    await waitFor(() => expect(tab(/Mine/)).toHaveTextContent('2'), T)
    await userEvent.click(tab(/Mine/))
    await waitFor(() => expect(listed()).toEqual(['anyones', 'hers']), T)
  })

  it('Mine says so when nothing is assigned to you', async () => {
    rows = [row('agents')]
    mount()
    await waitFor(() => expect(tab(/All/)).toHaveTextContent('1'), T)
    await userEvent.click(tab(/Mine/))
    await waitFor(() => expect(screen.getByText('Nothing assigned to you')).toBeInTheDocument(), T)
  })

  it('Mine has no Mark all read: that would clear tasks it does not show', async () => {
    rows = [
      row('new', { unread: true, activity: { seq: 8, kind: 'comment', at: 1 } }),
      row('yours', { assigneePersonId: 'local' }),
    ]
    mount()
    await waitFor(() => expect(tab(/Unread/)).toHaveTextContent('1'), T)
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument(),
      T,
    )
    await userEvent.click(tab(/Mine/))
    await waitFor(() => expect(listed()).toEqual(['yours']), T)
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull()
  })

  it('opens on Needs you when something waits, on Unread when nothing does', async () => {
    rows = [row('stuck', { status: 'blocked', attention: { reason: 'failed', failedRuns: 1 } })]
    const first = mount()
    await waitFor(() => expect(tab(/Needs you/)).toHaveAttribute('aria-selected', 'true'), T)
    first.unmount()

    rows = [row('new', { unread: true })]
    mount()
    await waitFor(() => expect(tab(/Unread/)).toHaveAttribute('aria-selected', 'true'), T)
  })

  it('opens on Needs you when the only thing waiting is an approval', async () => {
    useInboxStore.getState().apply({ unread: [], needsYou: [], approvals: ['x'], through: 0 })
    rows = [row('new', { unread: true })]
    mount()
    await waitFor(() => expect(tab(/Unread/)).toHaveTextContent('1'), T)
    expect(tab(/Needs you/)).toHaveAttribute('aria-selected', 'true')
  })

  it('stays on the tab it opened on when something new starts waiting', async () => {
    rows = [row('new', { unread: true })]
    mount()
    await waitFor(() => expect(tab(/Unread/)).toHaveAttribute('aria-selected', 'true'), T)

    rows = [
      row('new', { unread: true }),
      row('stuck', { status: 'blocked', attention: { reason: 'failed', failedRuns: 1 } }),
    ]
    act(() =>
      useInboxStore
        .getState()
        .apply({ unread: [], needsYou: ['stuck'], approvals: [], through: 9 }),
    )
    await waitFor(() => expect(tab(/Needs you/)).toHaveTextContent('1'), T)
    expect(tab(/Unread/)).toHaveAttribute('aria-selected', 'true')
  })

  it('lists what changed, newest change first, and says what the change was', async () => {
    rows = [
      row('older', { unread: true, activity: { seq: 3, kind: 'status', at: Date.now() } }),
      row('read'),
      row('newer', { unread: true, activity: { seq: 8, kind: 'comment', at: Date.now() } }),
      row('made', { unread: true, activity: { seq: 2, kind: 'created', at: Date.now() } }),
      row('edit', { unread: true, activity: { seq: 1, kind: 'edited', at: Date.now() } }),
    ]
    mount()
    await waitFor(() => expect(listed()).toEqual(['newer', 'older', 'made', 'edit']), T)
    const rowsShown = screen.getAllByTestId('inbox-row')
    expect(within(rowsShown[0]!).getByText(/New comment/)).toBeInTheDocument()
    expect(within(rowsShown[1]!).getByText(/Moved to To do/)).toBeInTheDocument()
    expect(within(rowsShown[2]!).getByText(/New task/)).toBeInTheDocument()
    expect(within(rowsShown[3]!).getByText(/Edited/)).toBeInTheDocument()
    expect(within(rowsShown[0]!).getByText(/Research/)).toBeInTheDocument()
  })

  it('All lists every task, the unread ones marked', async () => {
    rows = [row('new', { unread: true, activity: { seq: 8, kind: 'comment', at: 1 } }), row('old')]
    mount()
    await waitFor(() => expect(tab(/All/)).toHaveTextContent('2'), T)
    await userEvent.click(tab(/All/))
    await waitFor(() => expect(listed()).toEqual(['new', 'old']), T)
    expect(screen.getAllByTestId('inbox-row-unread')).toHaveLength(1)
  })

  it('opening a task clears it, through the change the page showed', async () => {
    rows = [row('a', { unread: true, activity: { seq: 8, kind: 'comment', at: Date.now() } })]
    useInboxStore.getState().apply({
      unread: [{ id: 'a', seq: 8 }],
      needsYou: [],
      approvals: [],
      through: 8,
    })
    mount()
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await userEvent.click(screen.getByTestId('inbox-row'))

    await waitFor(() => expect(reads).toEqual([{ taskId: 'a', through: 8 }]), T)
    expect(useInboxStore.getState().marks).toEqual({ a: 8 })
    // Left in place while it is open, so the list does not jump under the drawer.
    expect(listed()).toEqual(['a'])
    expect(screen.queryByTestId('inbox-row-unread')).not.toBeInTheDocument()
    expect(tab(/Unread/)).toHaveTextContent('0')
  })

  it('a task the person has read writes nothing on open', async () => {
    rows = [row('a')]
    mount()
    await waitFor(() => expect(tab(/All/)).toHaveTextContent('1'), T)
    await userEvent.click(tab(/All/))
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await userEvent.click(screen.getByTestId('inbox-row'))
    await screen.findAllByText('Task a', {}, T)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(reads).toEqual([])
  })

  it('reads again after the throttled inbox read, not on each event', async () => {
    rows = []
    mount()
    await waitFor(() => expect(boardReads).toBe(1), T)

    // A busy board: frames arrive, and the badge's watcher turns them into one read.
    rows = [row('a', { unread: true, activity: { seq: 2, kind: 'comment', at: Date.now() } })]
    act(() => {
      useAlertSignal.getState().noteBoardActivity(2)
      useAlertSignal.getState().noteBoardActivity(3)
      useAlertSignal.getState().noteInboxEvent(9)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(boardReads).toBe(1)

    act(() =>
      useInboxStore.getState().apply({ unread: [], needsYou: [], approvals: [], through: 3 }),
    )
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    expect(boardReads).toBe(2)
  })

  it('marks everything read through the newest change it showed', async () => {
    rows = [
      row('a', { unread: true, activity: { seq: 8, kind: 'comment', at: Date.now() } }),
      row('b', { unread: true, activity: { seq: 5, kind: 'status', at: Date.now() } }),
    ]
    mount()
    await waitFor(() => expect(listed()).toHaveLength(2), T)
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => expect(allReads).toEqual([{ through: 8 }]), T)
    expect(listed()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument()
  })

  it('says everything is read only once the server has agreed', async () => {
    let answer: (() => void) | undefined
    server.use(
      http.post('/api/board/inbox/read', async () => {
        await new Promise<void>((r) => (answer = r))
        return HttpResponse.json({ ok: true })
      }),
    )
    rows = [row('a', { unread: true, activity: { seq: 8, kind: 'comment', at: Date.now() } })]
    mount()
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => expect(answer).toBeDefined(), T)
    expect(screen.getByRole('status')).toHaveTextContent('')

    act(() => answer?.())
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('Everything marked read.'),
      T,
    )
  })

  it('says so and puts the list back when the server refuses', async () => {
    server.use(
      http.post('/api/board/inbox/read', () =>
        HttpResponse.json({ error: 'person_only' }, { status: 403 }),
      ),
    )
    rows = [row('a', { unread: true, activity: { seq: 8, kind: 'comment', at: Date.now() } })]
    mount()
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))

    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await waitFor(
      () =>
        expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
          'Couldn’t mark everything read. Please try again.',
        ),
      T,
    )
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('a team filter limits the list and the marking', async () => {
    useTeamStore.setState({ selectedTeamId: null })
    rows = [row('a', { unread: true, activity: { seq: 8, kind: 'comment', at: Date.now() } })]
    mount()
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await userEvent.click(screen.getByLabelText('Filter by team'))
    await userEvent.click(await screen.findByRole('option', { name: /Research/ }))
    await waitFor(() => expect(listed()).toEqual(['a']), T)
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => expect(allReads).toEqual([{ through: 8, teamId: 'team-a' }]), T)
  })

  it('says so when nothing is unread', async () => {
    rows = [row('a')]
    mount()
    await waitFor(() => expect(screen.getByTestId('inbox-empty')).toBeInTheDocument(), T)
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent('Nothing unread')
  })

  it('says so when the board cannot be read, rather than claiming nothing is new', async () => {
    server.use(http.get('/api/board', () => new HttpResponse(null, { status: 500 })))
    mount()
    await waitFor(() => expect(screen.getByText(/Couldn’t load your inbox/)).toBeInTheDocument(), T)
    expect(screen.queryByTestId('inbox-empty')).not.toBeInTheDocument()
  })

  it('shows a long list a page at a time', async () => {
    rows = Array.from({ length: 130 }, (_, i) =>
      row(`t${i}`, { unread: true, activity: { seq: 200 - i, kind: 'status', at: Date.now() } }),
    )
    mount()
    await waitFor(() => expect(listed()).toHaveLength(100), T)
    await userEvent.click(screen.getByRole('button', { name: /Show 30 more/ }))
    expect(listed()).toHaveLength(130)
  })
})
