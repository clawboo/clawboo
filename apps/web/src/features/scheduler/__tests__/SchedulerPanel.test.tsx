import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { confirm } from '@/stores/confirm'
import { SchedulerPanel } from '../SchedulerPanel'

// The design-system confirm() (replaces window.confirm) is mocked so the delete
// test drives the flow without rendering the app-root <ConfirmDialog>.
vi.mock('@/stores/confirm', async (orig) => ({
  ...(await orig<typeof import('@/stores/confirm')>()),
  confirm: vi.fn(),
}))

afterEach(() => {
  vi.mocked(confirm).mockReset()
  cleanup()
})

const FUTURE = 4_000_000_000_000

const SCHEDULES = [
  {
    id: 'clawboo-routine:r1',
    sourceScheduleId: 'r1',
    runtime: 'clawboo-native',
    owner: 'clawboo',
    source: 'clawboo-routine',
    agentId: 'n1',
    label: 'Nightly cleanup',
    cronSpec: '0 * * * *',
    nextRunAt: FUTURE,
    status: 'idle',
    manageability: 'managed',
    domain: 'team-task',
    tenantId: null,
  },
  {
    id: 'openclaw-gateway-cron:c1',
    sourceScheduleId: 'c1',
    runtime: 'openclaw',
    owner: 'openclaw',
    source: 'openclaw-gateway-cron',
    agentId: 'main',
    label: 'Morning brief',
    cronSpec: '0 9 * * *',
    nextRunAt: FUTURE,
    status: 'idle',
    manageability: 'external-write',
    domain: 'runtime-own-life',
    tenantId: null,
  },
]

const AGENTS = {
  defaultId: '',
  mainKey: 'main',
  agents: [
    { id: 'main', displayName: 'Main', runtime: 'openclaw', teamId: 't1' },
    { id: 'n1', displayName: 'Coder', runtime: 'clawboo-native', teamId: 't1' },
  ],
  stale: false,
}

beforeEach(() => {
  server.use(
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: SCHEDULES,
        sources: [
          { sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 },
          { sourceId: 'openclaw-gateway-cron', ok: true, degraded: false, at: 1 },
        ],
      }),
    ),
    http.get('/api/agents', () => HttpResponse.json(AGENTS)),
  )
})

describe('SchedulerPanel', () => {
  it('renders the merged view grouped by domain', async () => {
    render(<SchedulerPanel />)
    expect(await screen.findByText('Team work')).toBeInTheDocument()
    expect(screen.getByText("Runtime's own life")).toBeInTheDocument()
    expect(await screen.findByTestId('schedule-row-clawboo-routine:r1')).toBeInTheDocument()
    expect(screen.getByTestId('schedule-row-openclaw-gateway-cron:c1')).toBeInTheDocument()
    // The cron preset maps to a friendly label.
    expect(screen.getByText('Every hour')).toBeInTheDocument()
  })

  it('managed + external-write rows expose write actions', async () => {
    render(<SchedulerPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:r1')
    expect(within(row).getByTestId('schedule-clawboo-routine:r1-toggle')).toBeInTheDocument()
    expect(within(row).getByTestId('schedule-clawboo-routine:r1-run')).toBeInTheDocument()
    expect(within(row).getByTestId('schedule-clawboo-routine:r1-delete')).toBeInTheDocument()
  })

  it('observe-only rows render read-only (no action buttons)', async () => {
    server.use(
      http.get('/api/schedules', () =>
        HttpResponse.json({
          schedules: [{ ...SCHEDULES[0], id: 'clawboo-routine:ro', manageability: 'observe-only' }],
          sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
        }),
      ),
    )
    render(<SchedulerPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:ro')
    expect(within(row).getByText('read-only')).toBeInTheDocument()
    expect(within(row).queryByTestId('schedule-clawboo-routine:ro-toggle')).toBeNull()
  })

  it('create-from-UI gates intents by runtime + POSTs the right spec', async () => {
    const posted = vi.fn()
    server.use(
      http.post('/api/schedules', async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json({ schedule: { id: 'clawboo-routine:new' } }, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    render(<SchedulerPanel />)
    await user.click(await screen.findByTestId('schedule-create-open'))
    const dialog = await screen.findByTestId('schedule-dialog')

    // A native agent is selected first (sorted: Main openclaw is first option actually)
    // — explicitly pick the native agent and assert "Its own life" is disabled.
    // The custom Select renders a trigger button + a portaled listbox (not a
    // native <select>), so open it then click the option.
    await user.click(within(dialog).getByTestId('schedule-agent'))
    await user.click(await screen.findByRole('option', { name: /Coder .* Clawboo Native/i }))
    const ownLife = within(dialog).getByRole('button', { name: /its own life/i })
    expect(ownLife).toBeDisabled()

    // Submit a team-task routine for the native agent.
    await user.click(within(dialog).getByTestId('schedule-submit'))
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'clawboo-routine', domain: 'team-task', agentId: 'n1' }),
    )
  })

  it('delete is guarded by a confirmation (no DELETE on cancel, fires on confirm)', async () => {
    let deleted = 0
    server.use(
      http.delete('/api/schedules/:id', () => {
        deleted += 1
        return HttpResponse.json({ ok: true })
      }),
    )
    vi.mocked(confirm).mockResolvedValue(false)
    const user = userEvent.setup()
    render(<SchedulerPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:r1')

    await user.click(within(row).getByTestId('schedule-clawboo-routine:r1-delete'))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(deleted).toBe(0)

    vi.mocked(confirm).mockResolvedValue(true)
    await user.click(within(row).getByTestId('schedule-clawboo-routine:r1-delete'))
    await waitFor(() => expect(deleted).toBe(1))
  })

  it('renders a routine one-shot (once@) as a friendly label, not the raw spec', async () => {
    server.use(
      http.get('/api/schedules', () =>
        HttpResponse.json({
          schedules: [
            {
              ...SCHEDULES[0],
              id: 'clawboo-routine:once',
              cronSpec: 'once@2026-07-01T09:00:00.000Z',
            },
          ],
          sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
        }),
      ),
    )
    render(<SchedulerPanel />)
    expect(await screen.findByText('once · 2026-07-01T09:00:00.000Z')).toBeInTheDocument()
    expect(screen.queryByText(/once@/)).toBeNull()
  })

  it('an agent with no runtime cannot be scheduled for its own life (Gateway cron)', async () => {
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json({
          defaultId: '',
          mainKey: '',
          stale: false,
          // runtime intentionally omitted — must NOT default to openclaw.
          agents: [{ id: 'x', displayName: 'Mystery', teamId: null }],
        }),
      ),
    )
    const user = userEvent.setup()
    render(<SchedulerPanel />)
    await user.click(await screen.findByTestId('schedule-create-open'))
    const dialog = await screen.findByTestId('schedule-dialog')
    const ownLife = within(dialog).getByRole('button', { name: /its own life/i })
    expect(ownLife).toBeDisabled()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<SchedulerPanel />)
    await screen.findByText('Team work')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
