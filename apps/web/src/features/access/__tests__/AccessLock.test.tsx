// The dashboard's first read decides whether anything loads. A browser without the
// access cookie gets one screen that says how to get in; nothing behind it mounts,
// so it never fires the dozens of reads that would each fail with a 401.

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { server } from '@/__vitest__/mswServer'

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

  it('has no accessibility violations on the locked screen', async () => {
    server.use(http.get('/api/settings', () => HttpResponse.json(GATE_401, { status: 401 })))
    const { container } = renderLock()
    await screen.findByTestId('access-locked')
    expect(await axe(container)).toHaveNoViolations()
  })
})
