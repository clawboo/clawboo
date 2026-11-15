// Notification deep links from an app that shows the dashboard in its own
// window. The app's bridge delivers a target when the person clicks one of its
// notifications, and a click from before the dashboard subscribed is delivered
// once, on subscribe. The fake bridge here works like the desktop app's preload:
// subscribing "takes" the one pending target.

import { StrictMode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isDesktopShell } from '@/features/alerts/alertPrefs'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { server } from '../../../__vitest__/mswServer'
import { embedderBridge, parseOpenTarget, type OpenTarget } from '../bridge'
import { EmbedderLinks } from '../EmbedderLinks'
import {
  APPROVAL_GONE_MESSAGE,
  openEmbedderTarget,
  startEmbedderLinks,
  type OpenTargetDeps,
} from '../openTargets'

/** A bridge like the desktop app's: one pending click, taken on subscribe. */
function fakeBridge(pending: unknown = null) {
  let waiting = pending
  const listeners = new Set<(target: unknown) => void>()
  const subscribe = vi.fn((listener: (target: unknown) => void) => {
    listeners.add(listener)
    const taken = waiting
    waiting = null
    // The preload asks the main process for it, so it arrives a moment later.
    if (taken) void Promise.resolve().then(() => listener(taken))
    return () => listeners.delete(listener)
  })
  return {
    bridge: { isDesktop: true as const, onOpenTarget: subscribe },
    subscribe,
    click: (target: unknown) => listeners.forEach((l) => l(target)),
  }
}

function install(bridge: unknown): void {
  ;(window as { clawbooDesktop?: unknown }).clawbooDesktop = bridge
}

beforeEach(() => {
  useViewStore.setState({
    viewMode: { type: 'nav', view: 'graph' },
    boardFocus: null,
    boardNeedsYouFocus: null,
  })
  useFleetStore.setState({
    agents: [
      { id: 'coder', name: 'Coder', teamId: 'team-a' },
      { id: 'loner', name: 'Loner', teamId: null },
    ] as never,
  })
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useToastStore.setState({ toasts: [] })
  useSettingsModalStore.setState({ open: false })
})
afterEach(() => {
  cleanup()
  delete (window as { clawbooDesktop?: unknown }).clawbooDesktop
})

describe('parseOpenTarget', () => {
  it('takes the four kinds the app sends', () => {
    expect(parseOpenTarget({ kind: 'task', taskId: 't1' })).toEqual({ kind: 'task', taskId: 't1' })
    expect(parseOpenTarget({ kind: 'needs-you' })).toEqual({ kind: 'needs-you' })
    expect(parseOpenTarget({ kind: 'approval', approvalId: 'a1' })).toEqual({
      kind: 'approval',
      approvalId: 'a1',
    })
    expect(parseOpenTarget({ kind: 'approvals' })).toEqual({ kind: 'approvals' })
  })

  it('ignores anything else', () => {
    for (const raw of [
      null,
      'task',
      { kind: 'task' },
      { kind: 'task', taskId: '' },
      { kind: 'task', taskId: 42 },
      { kind: 'task', taskId: 'x'.repeat(257) },
      { kind: 'approval', approvalId: 'ap\n1' },
      { kind: 'task', taskId: 't\u00001' },
      { kind: 'approval', approvalId: null },
      { kind: 'agent', agentId: 'coder' },
      { kind: 'settings' },
    ]) {
      expect(parseOpenTarget(raw)).toBeNull()
    }
  })
})

describe('the bridge', () => {
  it('is the one the browser alerts detect, and only with isDesktop: true', () => {
    expect(embedderBridge()).toBeNull()
    expect(isDesktopShell()).toBe(false)
    install({ isDesktop: 'yes' })
    expect(embedderBridge()).toBeNull()
    expect(isDesktopShell()).toBe(false)
    install({ isDesktop: true })
    expect(embedderBridge()).not.toBeNull()
    expect(isDesktopShell()).toBe(true)
  })
})

describe('EmbedderLinks', () => {
  it('opens a task clicked before the dashboard subscribed, on its team', async () => {
    server.use(
      http.get('/api/board/t1', () =>
        HttpResponse.json({
          task: { id: 't1', title: 'Ship it', status: 'blocked', teamId: 'team-b' },
          comments: [],
          ancestors: [],
        }),
      ),
    )
    const app = fakeBridge({ kind: 'task', taskId: 't1' })
    install(app.bridge)
    render(<EmbedderLinks />)
    await waitFor(() =>
      expect(useViewStore.getState().boardFocus).toMatchObject({ taskId: 't1', teamId: 'team-b' }),
    )
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'board' })
  })

  it('opens what is clicked after it subscribed', async () => {
    const app = fakeBridge()
    install(app.bridge)
    render(<EmbedderLinks />)
    expect(app.subscribe).toHaveBeenCalledTimes(1)
    app.click({ kind: 'needs-you' })
    await waitFor(() =>
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
        teamId: 'all',
        approvalId: null,
      }),
    )
  })

  it('subscribes once, so StrictMode cannot lose a pending click', async () => {
    const app = fakeBridge({ kind: 'approvals' })
    install(app.bridge)
    render(
      <StrictMode>
        <EmbedderLinks />
      </StrictMode>,
    )
    await waitFor(() =>
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({ teamId: 'all' }),
    )
    expect(app.subscribe).toHaveBeenCalledTimes(1)
    expect(startEmbedderLinks(app.bridge)).toBe(false)
  })

  it('does nothing in a browser, or for an app from before deep links', () => {
    render(<EmbedderLinks />)
    install({ isDesktop: true })
    expect(() => render(<EmbedderLinks />)).not.toThrow()
    install({
      isDesktop: true,
      onOpenTarget: () => {
        throw new Error('refused')
      },
    })
    expect(startEmbedderLinks()).toBe(false)
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
  })

  it('ignores a target it does not know', async () => {
    const app = fakeBridge()
    install(app.bridge)
    render(<EmbedderLinks />)
    app.click({ kind: 'agent', agentId: 'coder' })
    app.click({ kind: 'task' })
    await new Promise((r) => setTimeout(r, 20))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'graph' })
  })
})

describe('openEmbedderTarget', () => {
  function deps(overrides: Partial<OpenTargetDeps> = {}): OpenTargetDeps {
    return {
      taskTeam: async () => 'team-a',
      findApproval: async () => ({ agentId: 'coder' }),
      teamOfAgent: (id) => (id === 'coder' ? 'team-a' : id === 'loner' ? null : undefined),
      toast: vi.fn(),
      ...overrides,
    }
  }

  it('closes Settings on the way', async () => {
    useSettingsModalStore.setState({ open: true })
    await openEmbedderTarget({ kind: 'needs-you' }, deps())
    expect(useSettingsModalStore.getState().open).toBe(false)
  })

  it('opens a task it cannot read all the same, and its drawer says what became of it', async () => {
    await openEmbedderTarget(
      { kind: 'task', taskId: 't9' },
      deps({ taskTeam: async () => undefined }),
    )
    expect(useViewStore.getState().boardFocus).toMatchObject({ taskId: 't9', teamId: null })
  })

  it('opens one approval under Needs you on its agent’s team, and asks for its card', async () => {
    await openEmbedderTarget({ kind: 'approval', approvalId: 'ap1' }, deps())
    expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
      teamId: 'team-a',
      approvalId: 'ap1',
    })
  })

  it('keeps the board’s team for an approval nobody can be attributed to (it shows on every team)', async () => {
    await openEmbedderTarget(
      { kind: 'approval', approvalId: 'ap1' },
      deps({ findApproval: async () => ({ agentId: null }) }),
    )
    expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
      teamId: null,
      approvalId: 'ap1',
    })
  })

  it('shows every team for an agent outside a team, or one this tab does not know', async () => {
    for (const agentId of ['loner', 'stranger']) {
      await openEmbedderTarget(
        { kind: 'approval', approvalId: 'ap1' },
        deps({ findApproval: async () => ({ agentId }) }),
      )
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
        teamId: 'all',
        approvalId: 'ap1',
      })
    }
  })

  it('says so when the approval was already answered, and shows what is left', async () => {
    const toast = vi.fn()
    await openEmbedderTarget(
      { kind: 'approval', approvalId: 'ap1' },
      deps({ findApproval: async () => 'gone', toast }),
    )
    expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
      teamId: 'all',
      approvalId: null,
    })
    expect(toast).toHaveBeenCalledWith(APPROVAL_GONE_MESSAGE)
  })

  it('still looks for the card when the approvals could not be read', async () => {
    await openEmbedderTarget(
      { kind: 'approval', approvalId: 'ap1' },
      deps({ findApproval: async () => null }),
    )
    expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
      teamId: 'all',
      approvalId: 'ap1',
    })
  })

  it('lets the newest click win over a slower read for an older one', async () => {
    let finish: (team: string) => void = () => {}
    const slow = openEmbedderTarget(
      { kind: 'task', taskId: 't1' },
      deps({ taskTeam: () => new Promise<string>((r) => (finish = r)) }),
    )
    await openEmbedderTarget({ kind: 'approvals' }, deps())
    finish('team-a')
    await slow
    expect(useViewStore.getState().boardFocus).toBeNull()
    expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({ teamId: 'all' })
  })

  describe('reading the approval', () => {
    const open = (approvalId: string) =>
      openEmbedderTarget({ kind: 'approval', approvalId } satisfies OpenTarget)

    it('finds a pending approval in the queue', async () => {
      server.use(
        http.get('/api/tools/approvals', () =>
          HttpResponse.json({
            approvals: [{ id: 'ap1', toolName: 'send_email', agentId: 'coder' }],
          }),
        ),
      )
      await open('ap1')
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
        teamId: 'team-a',
        approvalId: 'ap1',
      })
    })

    it('finds a shell approval the Gateway delivered before the server mirrored it', async () => {
      server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
      useApprovalsStore.setState({
        pendingApprovals: new Map([['ex1', { id: 'ex1', agentId: 'coder' } as never]]),
      })
      await open('ex1')
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
        teamId: 'team-a',
        approvalId: 'ex1',
      })
    })

    it('finds a shell approval the Gateway delivered while the queue was being read', async () => {
      server.use(
        http.get('/api/tools/approvals', () => {
          // Arrives after the first look at the live queue, before the answer.
          useApprovalsStore.setState({
            pendingApprovals: new Map([['ex2', { id: 'ex2', agentId: 'coder' } as never]]),
          })
          return HttpResponse.json({ approvals: [] })
        }),
      )
      await open('ex2')
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({
        teamId: 'team-a',
        approvalId: 'ex2',
      })
      expect(useToastStore.getState().toasts).toEqual([])
    })

    it('tells an answered approval from an unreadable queue', async () => {
      server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
      await open('ap1')
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([APPROVAL_GONE_MESSAGE])

      useToastStore.setState({ toasts: [] })
      server.use(http.get('/api/tools/approvals', () => new HttpResponse(null, { status: 500 })))
      await open('ap1')
      expect(useToastStore.getState().toasts).toEqual([])
      expect(useViewStore.getState().boardNeedsYouFocus).toMatchObject({ approvalId: 'ap1' })
    })
  })
})
