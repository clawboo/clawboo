import { cleanup, render, screen, within } from '@testing-library/react'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { FleetHealth } from '../FleetHealth'

afterEach(() => cleanup())

const SUMMARY = {
  generatedAt: 1,
  tenantId: null,
  totalAgents: 6,
  runtimes: [
    {
      runtime: 'openclaw',
      runtimeClass: 'connected-substrate',
      healthOk: true,
      agentCount: 4,
      healthy: 4,
      degraded: 0,
      down: 0,
    },
    {
      runtime: 'clawboo-native',
      runtimeClass: 'native',
      healthOk: true,
      agentCount: 2,
      healthy: 1,
      degraded: 1,
      down: 0,
    },
  ],
  tasks24h: { total: 3, done: 2, cancelled: 0, inProgress: 1, passRate: 1 },
  verification24h: { total: 1, pass: 1, fail: 0, debt: 0, passRate: 1 },
  spend24hUsd: 1.23,
  budgets: { count: 1, paused: 0 },
}

beforeEach(() => {
  server.use(
    http.get('/api/fleet/summary', () => HttpResponse.json(SUMMARY)),
    http.get('/api/obs/errors', () =>
      HttpResponse.json({
        errors: [{ runtime: 'hermes', errorClass: 'Network', message: 'timeout', ts: 1 }],
      }),
    ),
  )
})

describe('FleetHealth', () => {
  it('renders the metric strip + per-runtime tiles with depth badges', async () => {
    render(<FleetHealth />)
    // Header count.
    expect(await screen.findByText('6 agents')).toBeInTheDocument()
    // Metric strip.
    expect(screen.getByText('Task pass-rate · 24h')).toBeInTheDocument()
    expect(screen.getByText('$1.23')).toBeInTheDocument()
    // Per-runtime tiles with the same depth badge as the drawer.
    const ocTile = await screen.findByTestId('fleet-tile-openclaw')
    expect(within(ocTile).getByText(/connected substrate/i)).toBeInTheDocument()
    expect(within(ocTile).getByText(/4 healthy/i)).toBeInTheDocument()
    const nativeTile = screen.getByTestId('fleet-tile-clawboo-native')
    expect(within(nativeTile).getByText(/native peer/i)).toBeInTheDocument()
    expect(within(nativeTile).getByText(/1 degraded/i)).toBeInTheDocument()
  })

  it('renders recent issues from the obs taxonomy', async () => {
    render(<FleetHealth />)
    expect(await screen.findByText('Network')).toBeInTheDocument()
    expect(screen.getByText(/timeout/)).toBeInTheDocument()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<FleetHealth />)
    await screen.findByText('6 agents')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
