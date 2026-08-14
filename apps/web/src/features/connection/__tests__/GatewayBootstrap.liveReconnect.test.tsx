// End-to-end for the issue's acceptance criterion: emit `onStatus('reconnecting')`
// from the live client and assert BOTH that the store updates AND that the banner
// renders — plus the regression locks that make the feature safe. Before this
// change, `GatewayBootstrap` gated every overlay on a strict `status ===
// 'connected'`, so simply mirroring the drop would have thrown the full-screen
// connect modal (and the onboarding wizard) over a working dashboard.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeFakeGatewayClient } from '@/__vitest__/fakeGatewayClient'
import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { GatewayBootstrap } from '../GatewayBootstrap'

// A fully configured OpenClaw with a running Gateway. `configured` (installed &&
// configExists && envExists) is what makes the mount effect resolve to
// 'dashboard' — i.e. a returning user, no wizard, no extra probes.
const CONFIGURED_SYSTEM_INFO = {
  node: { version: 'v22.0.0', major: 22, sufficient: true, path: '/usr/bin/node' },
  openclaw: {
    installed: true,
    version: '0.3.0',
    path: '/usr/bin/openclaw',
    stateDir: '/tmp/.openclaw',
    configExists: true,
    envExists: true,
  },
  gateway: { running: true, port: 18789, pid: 1, managedByClawboo: false, uptimeMs: 1 },
}

let teamsHits = 0

beforeEach(() => {
  teamsHits = 0
  localStorage.setItem('clawboo.onboarded', '1')
  localStorage.removeItem('clawboo.wizard.active')
  // Otherwise the one-time tour opens a focus-trapped full-screen overlay.
  localStorage.setItem('clawboo.tour.shown', '1')
  localStorage.setItem('clawboo.firstTask.shown', '1')

  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({ teams: [], selectedTeamId: null })

  server.use(
    http.get('/api/system/status', () => HttpResponse.json(CONFIGURED_SYSTEM_INFO)),
    http.get('/api/teams', () => {
      teamsHits += 1
      return HttpResponse.json({ teams: [] })
    }),
  )
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

/**
 * Render the bootstrap as a settled, connected returning user.
 *
 * Seeds 'connected' rather than 'reconnecting' so the transition under test is a
 * real one, and so the auto-connect effect takes its early-return instead of
 * firing a rogue `/api/settings` (deliberately absent from the msw defaults, so a
 * spurious fetch fails the test loudly).
 */
async function renderConnected() {
  const fake = makeFakeGatewayClient('connected')
  useConnectionStore.setState({
    status: 'connected',
    client: fake.client,
    gatewayUrl: 'ws://localhost:18789',
  })
  const view = render(<GatewayBootstrap />)
  // `/api/teams` is the last fetch of the mount decision chain, so one hit means
  // the view has been decided and `setShowWizard(false)` has flushed.
  await waitFor(() => expect(teamsHits).toBe(1))
  return { fake, ...view }
}

describe('GatewayBootstrap — live socket drop', () => {
  it('mirrors onStatus("reconnecting") into the store and renders the banner', async () => {
    const { fake } = await renderConnected()
    expect(screen.queryByTestId('gateway-live-reconnect-banner')).not.toBeInTheDocument()

    act(() => fake.emit('reconnecting'))

    expect(useConnectionStore.getState().status).toBe('reconnecting')
    expect(await screen.findByTestId('gateway-live-reconnect-banner')).toBeInTheDocument()
  })

  it('returns the store to connected when the socket recovers', async () => {
    const { fake } = await renderConnected()
    act(() => fake.emit('reconnecting'))
    expect(await screen.findByTestId('gateway-live-reconnect-banner')).toBeInTheDocument()

    act(() => fake.emit('connected'))

    expect(useConnectionStore.getState().status).toBe('connected')
    // The banner's presence gate is `status === 'reconnecting'`, which this now
    // fails — the test above already proves it is absent at 'connected'. We do
    // NOT assert the node is gone here: it sits inside an <AnimatePresence>, and
    // framer-motion's exit transition does not settle under jsdom, so it would
    // be asserting on the animation library rather than on our gate.
  })
})

describe('GatewayBootstrap — a drop must not blow away the workspace', () => {
  it('does NOT pop the full-screen connect screen', async () => {
    // The highest-value lock in the file: every overlay used to gate on a strict
    // `=== 'connected'`, so mirroring the drop without widening those gates would
    // throw this modal over a working dashboard on every transient blip.
    const { fake } = await renderConnected()

    act(() => fake.emit('reconnecting'))

    await screen.findByTestId('gateway-live-reconnect-banner')
    expect(screen.queryByTestId('gateway-connect-screen')).not.toBeInTheDocument()
  })

  it('does NOT re-open the onboarding wizard', async () => {
    const { fake } = await renderConnected()

    act(() => fake.emit('reconnecting'))

    await screen.findByTestId('gateway-live-reconnect-banner')
    expect(screen.queryByText('Connect to an OpenClaw Gateway')).not.toBeInTheDocument()
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument()
  })

  it('does NOT show the blocking mount-time auto-connect spinner', async () => {
    // Two distinct surfaces that both say "reconnecting": the mount-time overlay
    // renders the exact string "Reconnecting…", the live banner "Reconnecting to
    // Gateway…". Assert on the exact strings so they can never be conflated.
    const { fake } = await renderConnected()

    act(() => fake.emit('reconnecting'))

    await screen.findByTestId('gateway-live-reconnect-banner')
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument()
  })
})

describe('GatewayBootstrap — escape from a Gateway that never comes back', () => {
  it('"Connect manually" stops the retry loop and lands on the connect screen', async () => {
    // The client retries forever, so without this the app would be stuck on
    // 'reconnecting' with no route back to the token / pairing form.
    const user = userEvent.setup()
    const { fake } = await renderConnected()
    act(() => fake.emit('reconnecting'))
    await screen.findByTestId('gateway-live-reconnect-banner')

    await user.click(screen.getByRole('button', { name: 'Connect manually' }))

    // `disconnect()` sets the client's manual flag, which is what stops the backoff.
    expect(fake.disconnect).toHaveBeenCalledOnce()
    const s = useConnectionStore.getState()
    expect(s.status).toBe('disconnected')
    expect(s.client).toBeNull()
    expect(await screen.findByTestId('gateway-connect-screen')).toBeInTheDocument()
  })
})
