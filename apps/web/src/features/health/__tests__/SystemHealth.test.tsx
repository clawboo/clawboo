// System Health panel — RTL/jsdom/msw. Renders a mixed pass/degraded BootReport:
// asserts the checklist, the degraded banner, the resolved runtime state + posture,
// and that "Re-run probe" POSTs /api/health/recheck and re-renders the new report.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { SystemHealthPanel } from '../SystemHealthPanel'

afterEach(() => cleanup())

const REPORT = {
  ok: true,
  startedAt: '2026-06-07T00:00:00.000Z',
  finishedAt: '2026-06-07T00:00:00.100Z',
  degraded: ['openclawGatewayReachable'],
  fatal: [],
  checks: [
    { id: 'clawbooHomeWritable', ok: true, message: 'clawboo home is writable', durationMs: 1 },
    { id: 'databaseIntegrity', ok: true, message: 'SQLite integrity check passed', durationMs: 2 },
    {
      id: 'openclawGatewayReachable',
      ok: false,
      message:
        'OpenClaw Gateway not reachable (disconnected) — serving last-synced agents from SQLite',
      detail: 'ws://localhost:18789',
      durationMs: 3,
    },
  ],
  config: {
    logLevel: 'info',
    budgetPosture: 'track-and-warn',
    budgetHardCapUsdCents: null,
    budgetWarnSoftPct: 80,
    otelEnabledByDefault: false,
    otelActive: false,
  },
  resolved: {
    clawbooHome: '/home/u/.clawboo',
    dbPath: '/home/u/.clawboo/clawboo.db',
    apiPort: 18790,
    stateDir: '/home/u/.openclaw',
    vaultPresent: true,
    masterKeyOk: true,
  },
}

const GREEN = { ...REPORT, degraded: [], checks: REPORT.checks.map((c) => ({ ...c, ok: true })) }

describe('SystemHealthPanel', () => {
  it('renders the checklist, the degraded banner, and the posture', async () => {
    server.use(http.get('/api/health', () => HttpResponse.json(REPORT)))

    render(<SystemHealthPanel />)

    await waitFor(() =>
      expect(screen.getByTestId('health-check-clawbooHomeWritable')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('health-check-databaseIntegrity')).toBeInTheDocument()
    expect(screen.getByTestId('health-check-openclawGatewayReachable')).toBeInTheDocument()

    // Degraded banner present (degraded.length > 0).
    expect(screen.getByTestId('system-health-banner')).toBeInTheDocument()
    expect(screen.getByText(/Running degraded/i)).toBeInTheDocument()

    // The failing check shows its detail.
    expect(screen.getByText('ws://localhost:18789')).toBeInTheDocument()

    // Production-defaults posture is surfaced (track-and-warn, no hard cap).
    expect(screen.getByText(/track-and-warn/i)).toBeInTheDocument()
    expect(screen.getByText('/home/u/.clawboo/clawboo.db')).toBeInTheDocument()
  })

  it('Re-run probe POSTs /api/health/recheck and re-renders the fresh report', async () => {
    server.use(
      http.get('/api/health', () => HttpResponse.json(REPORT)),
      http.post('/api/health/recheck', () => HttpResponse.json(GREEN)),
    )

    render(<SystemHealthPanel />)
    await waitFor(() => expect(screen.getByTestId('system-health-banner')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('system-health-recheck'))

    // After the recheck returns an all-green report, the banner is gone.
    await waitFor(() =>
      expect(screen.queryByTestId('system-health-banner')).not.toBeInTheDocument(),
    )
    expect(screen.getByText(/all systems go/i)).toBeInTheDocument()
  })
})
