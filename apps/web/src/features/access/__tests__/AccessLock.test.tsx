// The dashboard's first read decides whether anything loads. A browser without the
// access cookie gets one screen that says how to get in; nothing behind it mounts,
// so it never fires the dozens of reads that would each fail with a 401.

import { useEffect } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { apiFetch } from '@clawboo/control-client'

import { axe } from '@/__vitest__/axe'
import { server } from '@/__vitest__/mswServer'
import { PERSON_CHECK_REFUSED, resetPersonCheckNotices } from '@/lib/personCheckNotice'
import { useToastStore } from '@/stores/toast'

import { AccessLock } from '../AccessLock'

// The body packages/gateway-proxy/src/access-gate.ts writes on a 401.
const GATE_401 = {
  error:
    'Clawboo access token required. Run `clawboo open` on the computer running Clawboo, ' +
    'or open /?access_token=<token> once to set a cookie.',
  gate: 'clawboo-access',
}

afterEach(() => cleanup())

function renderLock() {
  return render(
    <AccessLock>
      <div data-testid="dashboard">dashboard</div>
    </AccessLock>,
  )
}

describe('AccessLock', () => {
  it('shows the locked screen, naming clawboo open, when the gate refuses the first read', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json(GATE_401, { status: 401 })))
    renderLock()
    expect(
      await screen.findByRole('heading', { name: /locked to your computer/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('clawboo open')).toBeInTheDocument()
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument()
  })

  it('recognises an older server by its refusal text alone', async () => {
    server.use(
      http.get('/api/settings', () =>
        HttpResponse.json(
          {
            error:
              'Clawboo access token required. Open /?access_token=<token> once to set a cookie.',
          },
          { status: 401 },
        ),
      ),
    )
    renderLock()
    expect(await screen.findByTestId('access-locked')).toBeInTheDocument()
  })

  it('renders nothing behind the lock while the first read is in flight', () => {
    server.use(http.get('/api/settings', () => new Promise<Response>(() => {})))
    renderLock()
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument()
    expect(screen.queryByTestId('access-locked')).not.toBeInTheDocument()
  })

  it('loads the dashboard when the read succeeds', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ gatewayUrl: '', hasToken: false })),
    )
    renderLock()
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
    expect(screen.queryByTestId('access-locked')).not.toBeInTheDocument()
  })

  it('loads the dashboard on a 401 that is not the gate (it handles its own errors)', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ error: 'nope' }, { status: 401 })),
    )
    renderLock()
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
  })

  it('loads the dashboard when the read fails outright', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.error()))
    renderLock()
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
  })

  it('gives up on a first read that never answers, and loads the dashboard', async () => {
    server.use(http.get('/api/settings', () => new Promise<Response>(() => {})))
    render(
      <AccessLock checkTimeoutMs={50}>
        <div data-testid="dashboard">dashboard</div>
      </AccessLock>,
    )
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
  })

  it('says why when the person check refuses something on an open dashboard', async () => {
    resetPersonCheckNotices()
    useToastStore.setState({ toasts: [] })
    server.use(
      http.get('/api/settings', () => HttpResponse.json({})),
      http.post('/api/board/t1/retry', () =>
        HttpResponse.json({ ok: false, error: 'person_only' }, { status: 403 }),
      ),
    )
    // The dashboard sends it, as a click would. A request the test sent once the
    // dashboard showed could be answered before AccessLock's effect began watching
    // responses (React runs that effect after the commit, a loaded runner later
    // still); the dashboard's own effect runs in the same flush, just before it.
    function Dashboard() {
      useEffect(() => {
        void apiFetch('/api/board/t1/retry', { method: 'POST' })
      }, [])
      return <div data-testid="dashboard">dashboard</div>
    }
    render(
      <AccessLock>
        <Dashboard />
      </AccessLock>,
    )
    await screen.findByTestId('dashboard')
    await waitFor(
      () => expect(useToastStore.getState().toasts[0]?.message).toBe(PERSON_CHECK_REFUSED),
      { timeout: 5_000 },
    )
  })

  it('locks a dashboard that is already open when a later read gets the gate refusal', async () => {
    // The server restarted with a new token, or the cookie was cleared: every
    // read from this tab now fails the same way.
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ gatewayUrl: '', hasToken: false })),
      http.get('/api/teams', () => HttpResponse.json(GATE_401, { status: 401 })),
    )
    function Dashboard() {
      useEffect(() => {
        void apiFetch('/api/teams')
      }, [])
      return <div data-testid="dashboard">dashboard</div>
    }
    render(
      <AccessLock>
        <Dashboard />
      </AccessLock>,
    )
    expect(await screen.findByTestId('access-locked')).toBeInTheDocument()
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument()
  })

  it('stays open on a later 401 that is not the gate', async () => {
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ gatewayUrl: '', hasToken: false })),
      http.get('/api/teams', () => HttpResponse.json({ error: 'nope' }, { status: 401 })),
    )
    let answered = false
    function Dashboard() {
      useEffect(() => {
        void apiFetch('/api/teams').then(() => (answered = true))
      }, [])
      return <div data-testid="dashboard">dashboard</div>
    }
    render(
      <AccessLock>
        <Dashboard />
      </AccessLock>,
    )
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument()
    await waitFor(() => expect(answered).toBe(true), { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('access-locked')).not.toBeInTheDocument()
  })

  it('has no accessibility violations on the locked screen', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json(GATE_401, { status: 401 })))
    const { container } = renderLock()
    await screen.findByTestId('access-locked')
    expect(await axe(container)).toHaveNoViolations()
  })
})
