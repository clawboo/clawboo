// Runtimes panel — the connection MANAGER. It renders the shared connect LIST
// (variant "panel"): the synthesized OpenClaw row plus the four non-OpenClaw
// runtimes (incl. the built-in native), status-driven from GET /api/runtimes
// (falling back to a Connect CTA when the fetch is not ok). Each row carries a
// diagnostics button (Re-check + Disconnect live in the drawer); connected rows
// show the premium indicator, unconnected rows an explicit CTA. RTL pattern (msw
// onUnhandledRequest: 'error'). The 8 s poll never fires in a sub-second test.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'

import { server } from '../../../__vitest__/mswServer'
import { RuntimesPanel } from '../RuntimesPanel'

// A truthy stub for a live OpenClaw Gateway client (the OpenClaw row is "connected"
// only when a real client is present, not merely when the app status is connected —
// native mode is app-connected with a null client).
const stubClient = {} as unknown as GatewayClient

beforeEach(() => {
  useConnectionStore.setState({ status: 'disconnected', client: null })
  // The OpenClaw row now also polls the server's registry health for thin-client
  // parity. Default it to disconnected so the browser-client assertions below are
  // unchanged; individual tests override it to prove the server-side signal.
  server.use(
    http.get('/api/agents/registry/health', () =>
      HttpResponse.json({ ok: false, connection: 'disconnected', lastSyncedAt: null }),
    ),
  )
})
afterEach(() => cleanup())

describe('RuntimesPanel', () => {
  it('renders OpenClaw + all four runtime rows (status from GET /api/runtimes)', async () => {
    useConnectionStore.setState({ status: 'connected', client: stubClient })
    server.use(
      http.get('/api/runtimes', () =>
        HttpResponse.json({
          runtimes: [
            {
              id: 'claude-code',
              participantKind: 'agent',
              capabilities: { streaming: true, mcp: true, worktrees: true, resume: true },
              health: { ok: true },
              installed: true,
              authKind: 'api-key',
              connectionState: 'ready',
            },
            {
              id: 'clawboo-native',
              participantKind: 'agent',
              capabilities: {
                streaming: true,
                mcp: true,
                worktrees: true,
                resume: true,
                runtimeClass: 'native',
              },
              health: { ok: false },
              installed: true,
              binPath: null,
              builtIn: true,
              authKind: 'api-key',
              connectionState: 'needs-auth',
            },
          ],
          available: [],
        }),
      ),
    )
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-clawboo-native')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-hermes')).toBeInTheDocument()
    // Connected claude-code settles to the premium indicator (the visible label +
    // its live region both carry the text); the built-in native (needs a key)
    // shows an explicit Connect CTA, never Install (it ships in the server).
    expect((await screen.findAllByText('Connected')).length).toBeGreaterThan(0)
    expect(
      await screen.findByTestId('runtime-list-row-clawboo-native-toggle'),
    ).toHaveAccessibleName(/connect clawboo native/i)
    expect(screen.queryByTestId('runtime-clawboo-native-install')).not.toBeInTheDocument()
  })

  it('renders rows from the catalog even when /api/runtimes is not ok', async () => {
    server.use(http.get('/api/runtimes', () => new HttpResponse(null, { status: 500 })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    // Rows still render (status unknown → a Connect CTA once the fetch settles),
    // never a blank panel.
    expect(await screen.findByTestId('runtime-list-row-clawboo-native-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-list-row-hermes')).toBeInTheDocument()
  })

  it('shows the "Set up OpenClaw" CTA on the OpenClaw row when NOT connected', async () => {
    useConnectionStore.setState({ status: 'disconnected', client: null })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)

    const toggle = await screen.findByTestId('runtime-list-row-openclaw-toggle')
    expect(toggle).toHaveAccessibleName(/set up openclaw/i)
    expect(screen.getByTestId('runtime-openclaw-setup')).toBeInTheDocument()
  })

  it('shows the CTA in NATIVE mode (app connected, but no OpenClaw client) — the P7 target', async () => {
    // Native-first user: the app is 'connected' via clawboo-native with a null
    // Gateway client. OpenClaw itself is NOT connected → the CTA must show.
    useConnectionStore.setState({ status: 'connected', client: null })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw-toggle')).toHaveAccessibleName(
      /set up openclaw/i,
    )
    expect(screen.getByTestId('runtime-openclaw-setup')).toBeInTheDocument()
  })

  it('hides the "Set up OpenClaw" CTA once OpenClaw is connected (a live client)', async () => {
    useConnectionStore.setState({ status: 'connected', client: stubClient })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    // Connected → the premium indicator + a Manage toggle, no setup button.
    expect(screen.queryByTestId('runtime-openclaw-setup')).not.toBeInTheDocument()
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
  })

  it('reads OpenClaw as connected from the server registry health with NO browser client (thin-client parity)', async () => {
    // Thin client: app connected via clawboo-native (null Gateway client), but the
    // server's OpenClaw operator connection is live → OpenClaw reads connected and
    // the CTA hides, even with no browser Gateway WS.
    useConnectionStore.setState({ status: 'connected', client: null })
    server.use(
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
      http.get('/api/agents/registry/health', () =>
        HttpResponse.json({ ok: true, connection: 'connected', lastSyncedAt: 1 }),
      ),
    )
    render(<RuntimesPanel />)

    expect(await screen.findByTestId('runtime-list-row-openclaw')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('runtime-openclaw-setup')).not.toBeInTheDocument(),
    )
  })

  it("a connected runtime's Manage body exposes a Details link (diagnostics)", async () => {
    server.use(
      http.get('/api/runtimes', () =>
        HttpResponse.json({
          runtimes: [
            {
              id: 'clawboo-native',
              connectionState: 'ready',
              capabilities: {},
              health: { ok: true },
            },
          ],
          available: [],
        }),
      ),
    )
    render(<RuntimesPanel />)
    // The ⓘ header button is gone; diagnostics now lives inside Manage as "Details".
    expect(await screen.findByTestId('runtime-clawboo-native-details')).toBeInTheDocument()
  })

  it('drops a drawer recheck whose answer is older than an applied refresh', async () => {
    // `recheckRuntime` narrows the SAME GET /api/runtimes the 8s poll reads, so the two
    // overlap and the later-issued answer must win. Here the recheck is issued first but
    // resolves last: merging it would revert the runtime to the pre-refresh state that the
    // user is staring at in the diagnostics drawer.
    let calls = 0
    let releaseRecheck: (() => void) | undefined
    let recheckAnswered = false
    const runtime = (connectionState: string) => ({
      runtimes: [{ id: 'clawboo-native', connectionState, capabilities: {}, health: { ok: true } }],
      available: [],
    })
    server.use(
      http.get('/api/runtimes', async () => {
        calls += 1
        // Call 2 is the drawer recheck: parked, and answers with the PRE-refresh state.
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            releaseRecheck = resolve
          })
          recheckAnswered = true
          return HttpResponse.json(runtime('ready'))
        }
        // Call 1 is the mount refresh; call 3+ is the header Refresh, which has newer news.
        return HttpResponse.json(runtime(calls === 1 ? 'ready' : 'needs-login'))
      }),
    )
    const user = userEvent.setup()
    render(<RuntimesPanel />)

    await user.click(await screen.findByTestId('runtime-clawboo-native-details'))
    const drawer = await screen.findByTestId('runtime-diagnostics-drawer')
    expect(drawer).toHaveTextContent('Connected')

    // Start the recheck (parks), then let a refresh land with the newer state.
    await user.click(screen.getByTestId('runtime-diagnostics-recheck'))
    await waitFor(() => expect(calls).toBe(2))
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-diagnostics-drawer')).toHaveTextContent('Needs login'),
    )

    // The stale recheck now answers 'ready'.
    releaseRecheck?.()
    await waitFor(() => expect(recheckAnswered).toBe(true))
    // `recheckAnswered` only proves the SERVER replied — asserting here could run before the
    // client finished the fetch → json → setStatuses chain, so a regressed guard would slip
    // through. The drawer re-enables Re-check only after `await onRecheck()` returns, which
    // is causally downstream of that whole chain: wait for that instead of a fixed delay.
    await waitFor(() => expect(screen.getByTestId('runtime-diagnostics-recheck')).toBeEnabled(), {
      timeout: 3000,
    })

    // It is discarded — the drawer keeps the fresher state.
    expect(screen.getByTestId('runtime-diagnostics-drawer')).toHaveTextContent('Needs login')
    expect(screen.getByTestId('runtime-diagnostics-drawer')).not.toHaveTextContent('Connected')
  })

  it('the disconnected OpenClaw row carries Set up + the MCP attach config', async () => {
    useConnectionStore.setState({ status: 'disconnected', client: null })
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    render(<RuntimesPanel />)
    // Expanding the Set up row reveals the setup CTA + MCP config.
    await userEvent.click(await screen.findByTestId('runtime-list-row-openclaw-toggle'))
    expect(screen.getByTestId('runtime-openclaw-setup')).toBeInTheDocument()
    expect(screen.getByText('MCP attach config')).toBeInTheDocument()
  })
})
