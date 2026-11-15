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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayClient } from '@clawboo/gateway-client'

import { useConnectionStore } from '@/stores/connection'

import { server } from '../../../__vitest__/mswServer'
import { cancelOpenClawWatch } from '../openClawOnDemand'
import { RuntimesPanel } from '../RuntimesPanel'

// Opening OpenClaw's row while it is not in use also brings up this page's own
// Gateway client once the server connects. Stubbed: no socket in these tests.
const browserConnect = vi.hoisted(() => ({
  connect: vi.fn(),
  enter: vi.fn(),
}))
vi.mock('@/lib/gatewayConnect', () => ({
  connectGatewayFromSettings: browserConnect.connect,
}))
vi.mock('@/features/connection/GatewayBootstrap', () => ({
  enterGatewayMode: browserConnect.enter,
}))

// A truthy stub for a live OpenClaw Gateway client (the OpenClaw row is "connected"
// only when a real client is present, not merely when the app status is connected —
// native mode is app-connected with a null client).
const stubClient = {} as unknown as GatewayClient

beforeEach(() => {
  browserConnect.connect.mockReset()
  browserConnect.connect.mockResolvedValue({
    client: stubClient,
    gatewayUrl: 'ws://localhost:18789',
  })
  browserConnect.enter.mockReset()
  browserConnect.enter.mockResolvedValue(undefined)
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
afterEach(() => {
  cleanup()
  // Opening OpenClaw starts a watch that outlives the panel; end it per test.
  cancelOpenClawWatch()
})

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

  it('native readied by local Ollama alone: Manage lists Ollama and Details says so', async () => {
    server.use(
      http.get('/api/runtimes', () =>
        HttpResponse.json({
          runtimes: [
            {
              id: 'clawboo-native',
              connectionState: 'ready',
              envVar: 'ANTHROPIC_API_KEY',
              hasCredential: false,
              ollamaConnected: true,
              capabilities: { runtimeClass: 'native' },
              health: { ok: true },
            },
          ],
          available: [],
        }),
      ),
    )
    const user = userEvent.setup()
    render(<RuntimesPanel />)
    expect(await screen.findByTestId('native-provider-row-ollama')).toHaveTextContent('Connected')
    await user.click(await screen.findByTestId('runtime-clawboo-native-details'))
    expect(await screen.findByTestId('runtime-diagnostics-drawer')).toHaveTextContent(
      'set up (no key needed)',
    )
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

  describe('OpenClaw set up and not in use (the server connects on demand)', () => {
    // The server reports `inUse: false` until something needs the Gateway, and a
    // Gateway that a service manager starts on its first connection stays asleep
    // until then. Opening OpenClaw's row is a need: the panel asks the server to
    // connect, once, and only when a person opens it.
    function configured(health: () => Record<string, unknown>, onConnect: () => void) {
      server.use(
        http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
        http.get('/api/system/openclaw-config', () =>
          HttpResponse.json({ config: { gateway: { port: 18789 } }, env: {}, version: null }),
        ),
        http.get('/api/agents/registry/health', () => HttpResponse.json(health())),
        http.post('/api/agents/registry/connect', () => {
          onConnect()
          return HttpResponse.json(health())
        }),
      )
    }

    it('reads "Not in use", not "Disconnected", and asks for nothing until opened', async () => {
      useConnectionStore.setState({ status: 'connected', client: null })
      let connects = 0
      configured(
        () => ({
          ok: false,
          connection: 'disconnected',
          lastSyncedAt: null,
          inUse: false,
          configured: true,
        }),
        () => (connects += 1),
      )
      render(<RuntimesPanel />)

      expect(await screen.findByText('Not in use')).toBeInTheDocument()
      expect(screen.queryByText('Disconnected')).not.toBeInTheDocument()
      expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveAccessibleName(
        /connect openclaw/i,
      )
      expect(connects).toBe(0)
    })

    it('opening the row asks the server to connect, once, and the row then reads connected', async () => {
      useConnectionStore.setState({ status: 'connected', client: null })
      let connects = 0
      let up = false
      configured(
        () =>
          up
            ? { ok: true, connection: 'connected', lastSyncedAt: 1, inUse: true, configured: true }
            : {
                ok: false,
                connection: 'disconnected',
                lastSyncedAt: null,
                inUse: false,
                configured: true,
              },
        () => {
          connects += 1
          up = true
        },
      )
      render(<RuntimesPanel />)
      await screen.findByText('Not in use')

      await userEvent.click(screen.getByTestId('runtime-list-row-openclaw-toggle'))

      await waitFor(() => expect(connects).toBe(1))
      await waitFor(() => expect(screen.queryByText('Not in use')).not.toBeInTheDocument())
      expect(screen.getAllByText('Connected').length).toBeGreaterThan(0)
      expect(connects).toBe(1)
      // The page loaded with no Gateway client, so it brings one up now.
      expect(browserConnect.connect).toHaveBeenCalledTimes(1)
      expect(browserConnect.enter).toHaveBeenCalledWith(stubClient, 'ws://localhost:18789')
    })

    it('a Gateway named only in settings (no local openclaw.json) reads Not in use too', async () => {
      // A remote or hand-configured Gateway: the server counts it as set up.
      useConnectionStore.setState({ status: 'connected', client: null })
      let connects = 0
      server.use(
        http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
        http.get('/api/agents/registry/health', () =>
          HttpResponse.json({
            ok: false,
            connection: 'disconnected',
            lastSyncedAt: null,
            inUse: false,
            configured: true,
          }),
        ),
        http.post('/api/agents/registry/connect', () => {
          connects += 1
          return HttpResponse.json({ ok: false, connection: 'connecting', inUse: true })
        }),
      )
      render(<RuntimesPanel />)

      expect(await screen.findByText('Not in use')).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('runtime-list-row-openclaw-toggle'))
      await waitFor(() => expect(connects).toBe(1))
    })

    it('a Gateway never set up reads Set up and asks for nothing when opened', async () => {
      useConnectionStore.setState({ status: 'connected', client: null })
      let connects = 0
      server.use(
        http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
        http.get('/api/agents/registry/health', () =>
          HttpResponse.json({
            ok: false,
            connection: 'disconnected',
            lastSyncedAt: null,
            inUse: false,
            configured: false,
          }),
        ),
        http.post('/api/agents/registry/connect', () => {
          connects += 1
          return HttpResponse.json({})
        }),
      )
      render(<RuntimesPanel />)

      const toggle = await screen.findByTestId('runtime-list-row-openclaw-toggle')
      expect(toggle).toHaveAccessibleName(/set up openclaw/i)
      await userEvent.click(toggle)
      expect(screen.queryByText('Not in use')).not.toBeInTheDocument()
      expect(connects).toBe(0)
    })

    it('a Gateway that does not answer after the open leaves the page without a client', async () => {
      useConnectionStore.setState({ status: 'connected', client: null })
      let connects = 0
      configured(
        () =>
          connects > 0
            ? {
                ok: false,
                connection: 'disconnected',
                lastSyncedAt: null,
                inUse: true,
                configured: true,
              }
            : {
                ok: false,
                connection: 'disconnected',
                lastSyncedAt: null,
                inUse: false,
                configured: true,
              },
        () => (connects += 1),
      )
      render(<RuntimesPanel />)
      await screen.findByText('Not in use')

      await userEvent.click(screen.getByTestId('runtime-list-row-openclaw-toggle'))

      await waitFor(() => expect(connects).toBe(1))
      expect(await screen.findByText('Disconnected')).toBeInTheDocument()
      expect(browserConnect.connect).not.toHaveBeenCalled()
    })

    it('a Gateway in use that is down still reads "Disconnected" with Reconnect', async () => {
      useConnectionStore.setState({ status: 'connected', client: null })
      let connects = 0
      configured(
        () => ({
          ok: false,
          connection: 'disconnected',
          lastSyncedAt: null,
          inUse: true,
          configured: true,
        }),
        () => (connects += 1),
      )
      render(<RuntimesPanel />)

      expect(await screen.findByText('Disconnected')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveAccessibleName(
        /reconnect openclaw/i,
      )
      await userEvent.click(screen.getByTestId('runtime-list-row-openclaw-toggle'))
      expect(connects).toBe(0)
    })
  })
})
