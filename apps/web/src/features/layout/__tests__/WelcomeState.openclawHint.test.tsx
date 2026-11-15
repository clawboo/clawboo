// The welcome screen's hint for an OpenClaw that nothing uses yet. The server
// connects to the Gateway on demand, so on a new Clawboo next to an OpenClaw
// already in use, none of its agents are here until someone opens OpenClaw.
// The hint says so and opens OpenClaw's row in Runtimes, which connects.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore } from '@/stores/team'

import { WelcomeState } from '../WelcomeState'

function status(over: { installed?: boolean; configExists?: boolean; inUse?: boolean }) {
  return {
    node: { version: 'v24.22.1', major: 24, sufficient: true, path: '' },
    openclaw: {
      installed: over.installed ?? true,
      version: '2026.9.37',
      path: '/usr/bin/openclaw',
      stateDir: '/tmp/.openclaw',
      configExists: over.configExists ?? true,
      envExists: true,
    },
    gateway: {
      running: false,
      inUse: over.inUse ?? false,
      port: 18789,
      pid: null,
      managedByClawboo: false,
      uptimeMs: null,
    },
  }
}

beforeEach(() => {
  // Native mode: the dashboard is up with no Gateway client.
  useConnectionStore.setState({ status: 'connected', client: null })
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useSettingsModalStore.setState({ open: false, focusRuntime: null })
})
afterEach(() => cleanup())

describe('WelcomeState: an OpenClaw nothing uses yet', () => {
  it('says how to bring in its agents, and opens OpenClaw in Runtimes', async () => {
    server.use(http.get('/api/system/status', () => HttpResponse.json(status({}))))
    render(<WelcomeState />)

    const hint = await screen.findByTestId('welcome-openclaw-hint')
    expect(hint).toHaveTextContent('OpenClaw is set up on this computer')
    await userEvent.click(screen.getByRole('button', { name: 'Open OpenClaw' }))
    expect(useSettingsModalStore.getState()).toMatchObject({
      open: true,
      view: 'runtimes',
      focusRuntime: 'openclaw',
    })
  })

  it('says nothing once the Gateway is in use', async () => {
    let reads = 0
    server.use(
      http.get('/api/system/status', () => {
        reads += 1
        return HttpResponse.json(status({ inUse: true }))
      }),
    )
    render(<WelcomeState />)
    await waitFor(() => expect(reads).toBeGreaterThan(0))
    expect(screen.queryByTestId('welcome-openclaw-hint')).toBeNull()
  })

  it('says nothing when OpenClaw is not set up here', async () => {
    let reads = 0
    server.use(
      http.get('/api/system/status', () => {
        reads += 1
        return HttpResponse.json(status({ configExists: false }))
      }),
    )
    render(<WelcomeState />)
    await waitFor(() => expect(reads).toBeGreaterThan(0))
    expect(screen.queryByTestId('welcome-openclaw-hint')).toBeNull()
  })
})
