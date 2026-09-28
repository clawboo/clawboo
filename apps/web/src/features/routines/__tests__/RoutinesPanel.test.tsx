import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { axe } from '@/__vitest__/axe'
import { confirm } from '@/stores/confirm'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'
import { RoutinesPanel } from '../RoutinesPanel'

// The design-system confirm() is mocked so the delete flow can be driven without
// rendering the app-root <ConfirmDialog>.
vi.mock('@/stores/confirm', async (orig) => ({
  ...(await orig<typeof import('@/stores/confirm')>()),
  confirm: vi.fn(),
}))

// The task drawer loads a task's board state, executions and workspace; opening
// it is what this suite checks, not what it shows.
vi.mock('@/features/board/TaskDetailDrawer', () => ({
  TaskDetailDrawer: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div data-testid="task-drawer-stub">
      {taskId}
      <button type="button" onClick={onClose}>
        close drawer
      </button>
    </div>
  ),
}))

const FUTURE = 4_000_000_000_000

const TEAM_ROUTINE = {
  id: 'clawboo-routine:r-team',
  sourceScheduleId: 'r-team',
  runtime: 'clawboo-native',
  owner: 'clawboo',
  source: 'clawboo-routine',
  agentId: '',
  target: 'team',
  teamId: 't1',
  teamName: 'Research',
  agentName: 'Boo Zero',
  label: 'Standup',
  description: 'Post a standup summary for the team.',
  cronSpec: '0 * * * *',
  nextRunAt: FUTURE,
  status: 'idle',
  manageability: 'managed',
  domain: 'team-task',
  tenantId: null,
}

const AGENT_ROUTINE = {
  ...TEAM_ROUTINE,
  id: 'clawboo-routine:r-agent',
  sourceScheduleId: 'r-agent',
  agentId: 'a1',
  target: 'agent',
  agentName: 'Ada',
  label: 'Inbox sweep',
  description: 'Draft replies to anything urgent.',
  cronSpec: '0 9 * * *',
}

const GATEWAY_JOB = {
  id: 'openclaw-gateway-cron:c1',
  sourceScheduleId: 'c1',
  runtime: 'openclaw',
  owner: 'openclaw',
  source: 'openclaw-gateway-cron',
  agentId: 'a2',
  agentName: 'Gus',
  label: 'Morning brief',
  cronSpec: '0 9 * * *',
  nextRunAt: FUTURE,
  status: 'idle',
  manageability: 'external-write',
  domain: 'runtime-own-life',
  tenantId: null,
}

const TEAMS = {
  teams: [
    { id: 't1', name: 'Research', icon: 'R', isArchived: 0 },
    { id: 't2', name: 'Growth', icon: 'G', isArchived: 0 },
  ],
  assignments: [],
}

const AGENTS = {
  defaultId: 'bz',
  mainKey: 'main',
  stale: false,
  agents: [
    {
      id: 'bz',
      displayName: 'Boo Zero',
      runtime: 'clawboo-native',
      teamId: null,
      archivedAt: null,
    },
    { id: 'a1', displayName: 'Ada', runtime: 'clawboo-native', teamId: 't1', archivedAt: null },
    { id: 'a3', displayName: 'Cy', runtime: 'claude-code', teamId: 't1', archivedAt: null },
    { id: 'a2', displayName: 'Gus', runtime: 'openclaw', teamId: 't2', archivedAt: null },
    { id: 'solo', displayName: 'Solo', runtime: 'codex', teamId: null, archivedAt: null },
  ],
}

const RUNS: Record<string, unknown[]> = {
  'clawboo-routine:r-team': [
    {
      firedAt: Date.now() - 60_000,
      finishedAt: Date.now() - 59_000,
      status: 'succeeded',
      error: null,
      taskId: null,
      dispatchPath: 'team-chat',
      targetAgentId: 'bz',
      task: null,
    },
  ],
  'clawboo-routine:r-agent': [
    {
      firedAt: Date.now() - 120_000,
      finishedAt: Date.now() - 60_000,
      status: 'succeeded',
      error: null,
      taskId: 'task-2',
      dispatchPath: 'one-shot',
      targetAgentId: null,
      task: { id: 'task-2', title: 'Inbox sweep', status: 'done' },
    },
    {
      firedAt: Date.now() - 86_400_000,
      finishedAt: Date.now() - 86_300_000,
      status: 'failed',
      error: 'run error: provider down',
      taskId: 'task-1',
      dispatchPath: 'one-shot',
      targetAgentId: null,
      task: { id: 'task-1', title: 'Inbox sweep', status: 'todo' },
    },
  ],
}

function useSchedules(schedules: unknown[], sources?: unknown[]): void {
  server.use(
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules,
        sources: sources ?? [
          { sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 },
          { sourceId: 'openclaw-gateway-cron', ok: true, degraded: false, at: 1 },
        ],
      }),
    ),
  )
}

beforeEach(() => {
  useSchedules([TEAM_ROUTINE, AGENT_ROUTINE, GATEWAY_JOB])
  server.use(
    http.get('/api/teams', () => HttpResponse.json(TEAMS)),
    http.get('/api/agents', () => HttpResponse.json(AGENTS)),
    http.get('/api/schedules/:id/runs', ({ params }) =>
      HttpResponse.json({ runs: RUNS[String(params['id'])] ?? [] }),
    ),
  )
})

afterEach(() => {
  // Unmount first: the panel follows the selected team, so resetting the store
  // under a mounted panel is a render outside act().
  cleanup()
  vi.mocked(confirm).mockReset()
  useSettingsModalStore.getState().close()
  useViewStore.getState().setViewMode({ type: 'nav', view: 'graph' })
  useTeamStore.getState().selectTeam(null)
})

describe('RoutinesPanel list', () => {
  it('groups team routines, agent routines and OpenClaw jobs, and says where each goes', async () => {
    render(<RoutinesPanel />)
    const team = await screen.findByTestId('routines-team')
    expect(within(team).getByText('Standup')).toBeInTheDocument()
    expect(within(team).getByText('Research team chat · Boo Zero leads')).toBeInTheDocument()
    expect(within(team).getByText('Every hour')).toBeInTheDocument()

    const agent = screen.getByTestId('routines-agent')
    expect(within(agent).getByText('Inbox sweep')).toBeInTheDocument()
    expect(within(agent).getByText('Ada · Research')).toBeInTheDocument()

    const gateway = screen.getByTestId('routines-gateway')
    expect(within(gateway).getByText('Morning brief')).toBeInTheDocument()
    expect(within(gateway).getByText('Gus · OpenClaw')).toBeInTheDocument()
    expect(screen.getByText('2 routines')).toBeInTheDocument()
  })

  it('is empty with a pointer to create one when nothing is scheduled', async () => {
    useSchedules([])
    render(<RoutinesPanel />)
    expect(await screen.findByText('No routines yet')).toBeInTheDocument()
    expect(screen.queryByTestId('routines-team')).toBeNull()
  })

  it('only mentions a disconnected Gateway to someone who uses OpenClaw', async () => {
    const degraded = [
      { sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 },
      {
        sourceId: 'openclaw-gateway-cron',
        ok: false,
        degraded: true,
        reason: 'gateway_disconnected',
        at: 1,
      },
    ]
    useSchedules([TEAM_ROUTINE], degraded)
    const { unmount } = render(<RoutinesPanel />)
    // Gus runs on OpenClaw, so the notice is relevant.
    expect(await screen.findByText(/OpenClaw Gateway is not connected/)).toBeInTheDocument()
    unmount()

    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json({
          ...AGENTS,
          agents: AGENTS.agents.filter((a) => a.runtime !== 'openclaw'),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    // Only a loaded directory can rule the notice out: the new-routine form shows
    // its teams once it has arrived.
    await user.click(await screen.findByTestId('routine-create-open'))
    await waitFor(() => expect(screen.getByTestId('routine-team')).toHaveTextContent('Growth'))
    expect(screen.queryByText(/OpenClaw Gateway is not connected/)).toBeNull()
  })

  it('observe-only rows render read-only (no action buttons)', async () => {
    useSchedules([{ ...AGENT_ROUTINE, id: 'clawboo-routine:ro', manageability: 'observe-only' }])
    render(<RoutinesPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:ro')
    expect(within(row).getByText('read-only')).toBeInTheDocument()
    expect(within(row).queryByTestId('schedule-clawboo-routine:ro-toggle')).toBeNull()
  })

  it('renders a one-shot (once@) as a friendly label, not the raw spec', async () => {
    useSchedules([{ ...AGENT_ROUTINE, cronSpec: 'once@2026-07-01T09:00:00.000Z' }])
    render(<RoutinesPanel />)
    expect(await screen.findByText('once · 2026-07-01T09:00:00.000Z')).toBeInTheDocument()
    expect(screen.queryByText(/once@/)).toBeNull()
  })

  it('a routine stopped by a failed run offers Resume, and run-now waits for it', async () => {
    const patched = vi.fn()
    useSchedules([{ ...AGENT_ROUTINE, status: 'error', nextRunAt: null, lastError: 'boom' }])
    server.use(
      http.patch('/api/schedules/:id', async ({ request }) => {
        patched(await request.json())
        return HttpResponse.json({ schedule: {} })
      }),
    )
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:r-agent')
    expect(within(row).getByText('boom')).toBeInTheDocument()
    expect(within(row).getByTestId('schedule-clawboo-routine:r-agent-run')).toBeDisabled()
    const toggle = within(row).getByTestId('schedule-clawboo-routine:r-agent-toggle')
    expect(toggle).toHaveAccessibleName('Resume')
    await user.click(toggle)
    await waitFor(() => expect(patched).toHaveBeenCalledWith({ action: 'resume' }))
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
    render(<RoutinesPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:r-team')

    await user.click(within(row).getByTestId('schedule-clawboo-routine:r-team-delete'))
    await waitFor(() => expect(confirm).toHaveBeenCalled())

    vi.mocked(confirm).mockResolvedValue(true)
    await user.click(within(row).getByTestId('schedule-clawboo-routine:r-team-delete'))
    // Once the confirmed delete has landed, any DELETE the cancelled one sent
    // (earlier) would have landed too: exactly one means cancel sent none.
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Deleted'),
    )
    expect(deleted).toBe(1)
  })

  it('a fire in flight cannot be paused or run again, and the row says why', async () => {
    useSchedules([
      { ...AGENT_ROUTINE, status: 'running' },
      { ...TEAM_ROUTINE, status: 'queued' },
    ])
    render(<RoutinesPanel />)
    const running = await screen.findByTestId('schedule-row-clawboo-routine:r-agent')
    const pause = within(running).getByTestId('schedule-clawboo-routine:r-agent-toggle')
    expect(pause).toBeDisabled()
    expect(pause).toHaveAccessibleName('Pause (it is running now)')
    expect(
      within(running).getByTestId('schedule-clawboo-routine:r-agent-run'),
    ).toHaveAccessibleName('Run now (it is running now)')

    // A queued fire has not started: it can still be paused, but not queued twice.
    const queued = screen.getByTestId('schedule-row-clawboo-routine:r-team')
    expect(within(queued).getByTestId('schedule-clawboo-routine:r-team-toggle')).toBeEnabled()
    const run = within(queued).getByTestId('schedule-clawboo-routine:r-team-run')
    expect(run).toBeDisabled()
    expect(run).toHaveAccessibleName('Run now (it is about to run)')
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<RoutinesPanel />)
    await screen.findByTestId('routines-team')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('RoutinesPanel detail', () => {
  it('opens a team routine: what it does, where it goes, its runs, and its team chat', async () => {
    useSettingsModalStore.getState().openSettings('routines')
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('schedule-open-clawboo-routine:r-team'))

    const dialog = await screen.findByTestId('routine-dialog')
    expect(within(dialog).getByRole('heading', { name: 'Standup' })).toBeInTheDocument()
    expect(within(dialog).getByText('Post a standup summary for the team.')).toBeInTheDocument()
    expect(within(dialog).getByText('Research team chat · Boo Zero leads')).toBeInTheDocument()
    const runs = await within(dialog).findByTestId('routine-runs')
    expect(within(runs).getByText('posted')).toBeInTheDocument()
    expect(within(runs).getByText('Posted to the team chat.')).toBeInTheDocument()

    await user.click(within(dialog).getByTestId('routine-open-chat'))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'groupChat', teamId: 't1' })
    expect(useTeamStore.getState().selectedTeamId).toBe('t1')
    expect(useSettingsModalStore.getState().open).toBe(false)
    await waitFor(() => expect(screen.queryByTestId('routine-dialog')).toBeNull())
  })

  it('opens an agent routine and a run opens the task it created', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('schedule-open-clawboo-routine:r-agent'))
    const dialog = await screen.findByTestId('routine-dialog')
    expect(within(dialog).getByText('Ada · Research')).toBeInTheDocument()
    expect(within(dialog).getByText(/Runs on Clawboo Native/)).toBeInTheDocument()
    const runs = await within(dialog).findByTestId('routine-runs')
    expect(within(runs).getByText('run error: provider down')).toBeInTheDocument()

    await user.click(within(runs).getByTestId('routine-run-task-task-2'))
    expect(await screen.findByTestId('task-drawer-stub')).toHaveTextContent('task-2')
    // The routine stays open behind the task.
    expect(screen.getByTestId('routine-dialog')).toBeInTheDocument()
  })

  it('edits a routine and sends only what changed', async () => {
    const patched = vi.fn()
    server.use(
      http.patch('/api/schedules/:id', async ({ request, params }) => {
        patched(params['id'], await request.json())
        return HttpResponse.json({ schedule: {} })
      }),
    )
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('schedule-open-clawboo-routine:r-agent'))
    const dialog = await screen.findByTestId('routine-dialog')
    await user.click(within(dialog).getByTestId('routine-edit'))

    // The form opens on the routine as it is.
    expect(within(dialog).getByRole('radio', { name: /an agent task/i })).toBeChecked()
    expect(within(dialog).getByTestId('routine-instructions')).toHaveValue(
      'Draft replies to anything urgent.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Weekdays · 9am' }))
    await user.click(within(dialog).getByTestId('routine-submit'))

    await waitFor(() =>
      expect(patched).toHaveBeenCalledWith('clawboo-routine:r-agent', {
        patch: { cronSpec: '0 9 * * 1-5' },
      }),
    )
    // Back to reading it.
    expect(await within(dialog).findByTestId('routine-edit')).toBeInTheDocument()
  })

  it('a routine whose team is gone says so and offers no chat to open', async () => {
    useSchedules([{ ...TEAM_ROUTINE, teamName: undefined, agentName: undefined }])
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    const row = await screen.findByTestId('schedule-row-clawboo-routine:r-team')
    expect(within(row).getByText('Team not found')).toBeInTheDocument()
    await user.click(within(row).getByTestId('schedule-open-clawboo-routine:r-team'))
    const dialog = await screen.findByTestId('routine-dialog')
    expect(within(dialog).getByText('Team not found')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('routine-open-chat')).toBeNull()
  })

  it('keeps focus in the dialog when switching between reading and editing', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('schedule-open-clawboo-routine:r-agent'))
    const dialog = await screen.findByTestId('routine-dialog')
    await user.click(within(dialog).getByTestId('routine-edit'))
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await within(dialog).findByTestId('routine-edit')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  it('a Gateway job opens read-only about where it runs, with enable/disable', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('schedule-open-openclaw-gateway-cron:c1'))
    const dialog = await screen.findByTestId('routine-dialog')
    expect(within(dialog).getByText(/belongs to the OpenClaw Gateway/)).toBeInTheDocument()
    expect(within(dialog).queryByTestId('routine-edit')).toBeNull()
    expect(within(dialog).getByTestId('routine-toggle')).toHaveTextContent('Disable')
  })

  it('the open dialog has no level-A/AA a11y violations', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('schedule-open-clawboo-routine:r-agent'))
    const dialog = await screen.findByTestId('routine-dialog')
    await within(dialog).findByTestId('routine-runs')
    expect(await axe(dialog)).toHaveNoViolations()
  })
})

describe('RoutinesPanel create', () => {
  it('a team task is sent to a team, not to an agent', async () => {
    const posted = vi.fn()
    server.use(
      http.post('/api/schedules', async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json({ schedule: { id: 'clawboo-routine:new' } }, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')

    // A team task by default, with teams to choose from and no agent picker.
    expect(within(dialog).getByRole('radio', { name: /a team task/i })).toBeChecked()
    expect(within(dialog).queryByTestId('routine-agent')).toBeNull()
    expect(within(dialog).getByText(/Boo Zero picks it up/)).toBeInTheDocument()

    await user.click(within(dialog).getByTestId('routine-team'))
    await user.click(await screen.findByRole('option', { name: /Research/ }))
    await user.type(
      within(dialog).getByTestId('routine-instructions'),
      'Summarize what shipped yesterday.',
    )
    await user.click(within(dialog).getByTestId('routine-submit'))

    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith({
        source: 'clawboo-routine',
        domain: 'team-task',
        target: 'team',
        teamId: 't1',
        cronSpec: '0 * * * *',
        label: 'Summarize what shipped yesterday.',
        taskTemplate: { description: 'Summarize what shipped yesterday.' },
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('routine-dialog')).toBeNull())
  })

  it('an agent task asks for the team, then an agent on it', async () => {
    const posted = vi.fn()
    server.use(
      http.post('/api/schedules', async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json({ schedule: { id: 'clawboo-routine:new' } }, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')

    await user.click(within(dialog).getByRole('radio', { name: /an agent task/i }))
    await user.click(within(dialog).getByTestId('routine-team'))
    await user.click(await screen.findByRole('option', { name: /Research/ }))

    // Only Research's agents are offered, by name, with their runtime.
    await user.click(within(dialog).getByTestId('routine-agent'))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Ada · Clawboo Native', 'Cy · Claude Code'])
    await user.click(screen.getByRole('option', { name: 'Cy · Claude Code' }))

    await user.type(within(dialog).getByTestId('routine-name'), 'Nightly tests')
    await user.type(within(dialog).getByTestId('routine-instructions'), 'Run the test suite.')
    await user.click(within(dialog).getByRole('button', { name: 'Daily · 9am' }))
    await user.click(within(dialog).getByTestId('routine-submit'))

    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith({
        source: 'clawboo-routine',
        domain: 'team-task',
        target: 'agent',
        agentId: 'a3',
        teamId: 't1',
        cronSpec: '0 9 * * *',
        label: 'Nightly tests',
        taskTemplate: { description: 'Run the test suite.' },
      }),
    )
  })

  it('starts on the team being looked at, even when the teams arrive after the form', async () => {
    const posted = vi.fn()
    let releaseTeams: () => void = () => {}
    const teamsGate = new Promise<void>((resolve) => {
      releaseTeams = resolve
    })
    server.use(
      http.get('/api/teams', async () => {
        await teamsGate
        return HttpResponse.json(TEAMS)
      }),
      http.post('/api/schedules', async ({ request }) => {
        posted(await request.json())
        return HttpResponse.json({ schedule: { id: 'clawboo-routine:new' } }, { status: 201 })
      }),
    )
    // Research sorts after Growth, so only the preference can pick it.
    useTeamStore.getState().selectTeam('t1')
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')
    expect(within(dialog).getByTestId('routine-team')).toHaveTextContent('No teams yet')

    releaseTeams()
    await waitFor(() =>
      expect(within(dialog).getByTestId('routine-team')).toHaveTextContent('Research'),
    )
    await user.type(within(dialog).getByTestId('routine-instructions'), 'Plan the week.')
    await user.click(within(dialog).getByTestId('routine-submit'))
    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith(expect.objectContaining({ teamId: 't1' })),
    )
  })

  it('offers standalone agents under No team for an agent task only', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')

    await user.click(within(dialog).getByTestId('routine-team'))
    expect(screen.queryByRole('option', { name: /No team/ })).toBeNull()
    await user.keyboard('{Escape}')

    await user.click(within(dialog).getByRole('radio', { name: /an agent task/i }))
    await user.click(within(dialog).getByTestId('routine-team'))
    await user.click(await screen.findByRole('option', { name: /No team/ }))
    await user.click(within(dialog).getByTestId('routine-agent'))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Boo Zero · Clawboo Native', 'Solo · Codex'])
  })

  it('a custom schedule is checked before it can be saved', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')
    await user.type(within(dialog).getByTestId('routine-instructions'), 'Do it.')
    await user.click(within(dialog).getByRole('button', { name: 'Custom' }))
    const cron = within(dialog).getByTestId('routine-cron')
    await user.clear(cron)
    await user.type(cron, 'every day')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/not a cron expression/)
    expect(within(dialog).getByTestId('routine-submit')).toBeDisabled()

    await user.clear(cron)
    await user.type(cron, '30 8 * * 1-5')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByTestId('routine-next-preview')).toHaveTextContent(/Next run/)
    expect(within(dialog).getByTestId('routine-submit')).toBeEnabled()
  })

  it('a refused create keeps the dialog open with the reason', async () => {
    server.use(
      http.post('/api/schedules', () =>
        HttpResponse.json(
          { error: 'The team "Research" is archived.', code: 'invalid_routine_target' },
          { status: 400 },
        ),
      ),
    )
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')
    await user.type(within(dialog).getByTestId('routine-instructions'), 'Do it.')
    await user.click(within(dialog).getByTestId('routine-submit'))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'The team "Research" is archived.',
      ),
    )
    expect(screen.getByTestId('routine-dialog')).toBeInTheDocument()
    expect(within(dialog).getByTestId('routine-instructions')).toHaveValue('Do it.')
  })
})

// Issue #95: Escape on an open dropdown inside the dialog dismisses only the
// dropdown; the dialog and what was typed survive, and the next Escape closes it.
describe('RoutineDialog Escape layering', () => {
  it('dismisses an open Select first, then the dialog', async () => {
    const user = userEvent.setup()
    render(<RoutinesPanel />)
    await user.click(await screen.findByTestId('routine-create-open'))
    const dialog = await screen.findByTestId('routine-dialog')
    await user.type(within(dialog).getByTestId('routine-name'), 'Nightly sweep')

    await user.click(within(dialog).getByTestId('routine-team'))
    expect(await screen.findByRole('option', { name: /Research/ })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('option', { name: /Research/ })).toBeNull())
    expect(screen.getByTestId('routine-dialog')).toBeInTheDocument()
    expect(within(dialog).getByTestId('routine-name')).toHaveValue('Nightly sweep')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('routine-dialog')).toBeNull())
  })
})
