// The browser alerts end to end in the page: quiet while the tab is in front,
// one alert for what arrives while it is in the background, a click that opens
// the task, and silence inside the desktop app or when turned off. The board
// and approval reads go through msw; the Notification API is a recording fake.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useApprovalsStore, type ApprovalRequest } from '@/stores/approvals'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'

import { useAlertPrefs } from '../alertPrefs'
import { useAlertSignal } from '../alertSignal'
import { NeedsYouAlerts } from '../NeedsYouAlerts'

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static shown: FakeNotification[] = []
  onclick: (() => void) | null = null
  closed = false
  constructor(
    public title: string,
    public options: NotificationOptions = {},
  ) {
    FakeNotification.shown.push(this)
  }
  close(): void {
    this.closed = true
  }
}

const failed = (id: string, title: string) => ({
  id,
  title,
  status: 'blocked',
  teamId: 'team-a',
  attention: { reason: 'failed', failedRuns: 1 },
  updatedAt: 1000,
  personMovedAt: null,
})

let tasks: unknown[] = []
let boardReads = 0
let focused = true

function goBackground(): void {
  focused = false
  act(() => {
    window.dispatchEvent(new Event('blur'))
  })
}

function signal(seq: number): void {
  act(() => {
    useAlertSignal.getState().note(seq)
  })
}

beforeEach(() => {
  vi.stubGlobal('Notification', FakeNotification)
  FakeNotification.permission = 'granted'
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  tasks = [failed('old', 'Already waiting')]
  boardReads = 0
  server.use(
    http.get('/api/board', () => {
      boardReads += 1
      return HttpResponse.json({ tasks })
    }),
  )
  useAlertPrefs.setState({ choice: 'on', permission: 'granted' })
  useAlertSignal.setState({ seq: 0 })
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useFleetStore.setState({
    agents: [{ id: 'ada', name: 'Ada', teamId: 'team-a' } as AgentState],
  })
  useViewStore.setState({
    viewMode: { type: 'nav', view: 'graph' },
    boardFocus: null,
    boardNeedsYouFocus: null,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (window as { clawbooDesktop?: unknown }).clawbooDesktop
})

describe('NeedsYouAlerts', () => {
  it('reads nothing and says nothing while the tab is in front', async () => {
    render(<NeedsYouAlerts batchMs={10} />)
    tasks = [...tasks, failed('new', 'Fresh failure')]
    signal(5)
    await new Promise((r) => setTimeout(r, 60))
    expect(boardReads).toBe(0)
    expect(FakeNotification.shown).toEqual([])
    // Asking for permission is the opt-in's job, on a click, never this one's.
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })

  it('announces only what arrives in the background, and a click opens the task', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    render(<NeedsYouAlerts batchMs={10} />)
    goBackground()
    await waitFor(() => expect(boardReads).toBe(1)) // what is waiting now is seen

    tasks = [...tasks, failed('new', 'Send the invoice')]
    signal(5)
    signal(6) // the same burst
    await waitFor(() => expect(FakeNotification.shown).toHaveLength(1))
    const n = FakeNotification.shown[0]!
    expect(n.title).toBe('A task needs you')
    expect(n.options.body).toBe('"Send the invoice" failed. Click to open it.')
    expect(n.options.tag).toContain('task:new:failed')

    act(() => n.onclick?.())
    expect(focus).toHaveBeenCalled()
    expect(n.closed).toBe(true)
    const view = useViewStore.getState()
    expect(view.viewMode).toEqual({ type: 'nav', view: 'board' })
    expect(view.boardFocus).toMatchObject({ taskId: 'new', teamId: 'team-a' })
  })

  it('forgets on the way back, so only later arrivals count next time', async () => {
    render(<NeedsYouAlerts batchMs={10} />)
    goBackground()
    await waitFor(() => expect(boardReads).toBe(1))

    // Back in front: the person sees the new task on the board themselves.
    focused = true
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    tasks = [...tasks, failed('seen', 'Seen in front')]
    signal(7)
    await new Promise((r) => setTimeout(r, 60))
    expect(FakeNotification.shown).toEqual([])

    goBackground()
    await waitFor(() => expect(boardReads).toBe(2))
    signal(8)
    await new Promise((r) => setTimeout(r, 60))
    expect(FakeNotification.shown).toEqual([])
  })

  it('announces a shell approval the Gateway socket delivers', async () => {
    render(<NeedsYouAlerts batchMs={10} />)
    goBackground()
    await waitFor(() => expect(boardReads).toBe(1))

    const req = {
      id: 'ex-1',
      agentId: 'ada',
      command: 'rm -rf build',
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    } as ApprovalRequest
    act(() => {
      useApprovalsStore.setState({ pendingApprovals: new Map([[req.id, req]]) })
    })
    await waitFor(() => expect(FakeNotification.shown).toHaveLength(1))
    expect(FakeNotification.shown[0]!.title).toBe('Ada needs your approval')
    expect(FakeNotification.shown[0]!.options.body).toBe(
      'It wants to run a command. Click to allow or deny.',
    )

    act(() => FakeNotification.shown[0]!.onclick?.())
    expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({ teamId: 'team-a' })
  })

  it('stays quiet inside the desktop app, which raises its own', async () => {
    ;(window as { clawbooDesktop?: unknown }).clawbooDesktop = { isDesktop: true }
    render(<NeedsYouAlerts batchMs={10} />)
    goBackground()
    tasks = [...tasks, failed('new', 'Fresh failure')]
    signal(5)
    await new Promise((r) => setTimeout(r, 60))
    expect(boardReads).toBe(0)
    expect(FakeNotification.shown).toEqual([])
  })

  it('stays quiet when turned off, or when the browser blocks it', async () => {
    useAlertPrefs.setState({ choice: 'off' })
    const { unmount } = render(<NeedsYouAlerts batchMs={10} />)
    goBackground()
    signal(5)
    await new Promise((r) => setTimeout(r, 60))
    expect(boardReads).toBe(0)
    unmount()

    useAlertPrefs.setState({ choice: 'on', permission: 'denied' })
    render(<NeedsYouAlerts batchMs={10} />)
    goBackground()
    signal(6)
    await new Promise((r) => setTimeout(r, 60))
    expect(boardReads).toBe(0)
    expect(FakeNotification.shown).toEqual([])
  })
})
