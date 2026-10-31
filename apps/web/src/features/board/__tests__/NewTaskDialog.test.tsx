// The New task dialog leads with one field and a suggested agent: the sentence's
// words against each member's role (GET /api/teams/member-roles), else the agent
// last given a task, else the team lead. Enter sends it, picking an agent picks
// its team, and More options opens the full form. The POST body is unchanged.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'

import { server } from '../../../__vitest__/mswServer'
import { NewTaskDialog } from '../NewTaskDialog'
import { resetBoardStorage } from './resetBoardStorage'

const ALPHA = {
  id: 'team-1',
  name: 'Alpha',
  icon: '🐙',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 2,
  leaderAgentId: null as string | null,
  isArchived: false,
  serverOrchestrated: true,
}
const BETA = { ...ALPHA, id: 'team-2', name: 'Beta', agentCount: 1 }

const ROLES = {
  ada: 'Drafts blog posts, launch notes and announcements.',
  coder: 'Fixes failing tests and ships small patches.',
}

function seed(teams = [ALPHA, BETA]): void {
  useTeamStore.setState({ teams, selectedTeamId: null })
  useFleetStore.setState({
    // Coder comes first, so a role match is told apart from the first member.
    agents: [
      { id: 'coder', name: 'Coder', teamId: 'team-1' },
      { id: 'ada', name: 'Ada', teamId: 'team-1' },
      { id: 'critic', name: 'Critic', teamId: 'team-2' },
    ] as never,
  })
}

/** Serves the roles and records every create. */
function serve(roles: Record<string, string> = ROLES): Record<string, unknown>[] {
  const posted: Record<string, unknown>[] = []
  server.use(
    http.get('/api/teams/member-roles', () => HttpResponse.json({ roles })),
    http.post('/api/board', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      posted.push(body)
      return HttpResponse.json({ task: { id: `new${posted.length}`, title: body['title'] } })
    }),
  )
  return posted
}

function renderDialog(defaultTeamId?: string) {
  const onClose = vi.fn()
  const onCreated = vi.fn()
  render(
    <NewTaskDialog open onClose={onClose} onCreated={onCreated} defaultTeamId={defaultTeamId} />,
  )
  const dialog = screen.getByTestId('new-task-dialog')
  return {
    dialog,
    onClose,
    onCreated,
    field: within(dialog).getByLabelText('What should get done?'),
  }
}

beforeEach(() => {
  resetBoardStorage()
  useToastStore.setState({ toasts: [] })
})
afterEach(() => cleanup())

describe('NewTaskDialog', () => {
  it('leads with one field and sends the task to the agent whose role fits, on Enter', async () => {
    seed()
    const posted = serve()
    const user = userEvent.setup()
    const { dialog, field, onClose, onCreated } = renderDialog()

    await waitFor(() => expect(field).toHaveFocus())
    // The full form waits behind More options.
    expect(within(dialog).queryByLabelText('Team')).toBeNull()
    expect(within(dialog).queryByLabelText(/Details/)).toBeNull()

    await user.type(field, 'Draft the launch announcement')
    const agent = within(dialog).getByLabelText('Agent')
    // Two teams in view, so the suggestion names its team too.
    await waitFor(() => expect(agent).toHaveTextContent('Ada, Alpha'))
    expect(within(dialog).getByTestId('new-task-suggestion')).toHaveTextContent('Fits the task')

    await user.keyboard('{Enter}')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posted).toEqual([
      { title: 'Draft the launch announcement', teamId: 'team-1', assigneeAgentId: 'ada' },
    ])
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new1' }))
  })

  it('keeps the agent the person picks, and its team comes with it', async () => {
    seed()
    const posted = serve()
    const user = userEvent.setup()
    const { dialog, field } = renderDialog()

    await user.click(within(dialog).getByLabelText('Agent'))
    await user.click(await screen.findByRole('option', { name: 'Critic, Beta' }))
    // A sentence that fits Ada's role does not take the pick away.
    await user.type(field, 'Draft the launch announcement{Enter}')

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ teamId: 'team-2', assigneeAgentId: 'critic' })
    expect(within(dialog).queryByTestId('new-task-suggestion')).toBeNull()
  })

  it('falls back to the team lead, then to the agent last given a task', async () => {
    seed([{ ...ALPHA, leaderAgentId: 'ada' }, BETA])
    const posted = serve()
    const user = userEvent.setup()
    const { dialog, field, onClose } = renderDialog('team-1')

    await user.type(field, 'Something vague')
    expect(within(dialog).getByLabelText('Agent')).toHaveTextContent('Ada')
    expect(within(dialog).getByTestId('new-task-suggestion')).toHaveTextContent('Team lead')
    // The board's team filter keeps the other team's agents out.
    await user.click(within(dialog).getByLabelText('Agent'))
    expect(screen.queryByRole('option', { name: /Critic/ })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'Coder' }))
    await user.type(field, '{Enter}')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(posted[0]).toMatchObject({ assigneeAgentId: 'coder' })

    cleanup()
    const reopened = renderDialog('team-1')
    await user.type(reopened.field, 'Something else vague')
    expect(within(reopened.dialog).getByLabelText('Agent')).toHaveTextContent('Coder')
    expect(within(reopened.dialog).getByTestId('new-task-suggestion')).toHaveTextContent(
      'Last used',
    )
  })

  it('opens the full form under More options and sends the details', async () => {
    seed()
    const posted = serve()
    const user = userEvent.setup()
    const { dialog, field } = renderDialog()

    await user.type(field, 'Draft the launch announcement')
    await user.click(within(dialog).getByRole('button', { name: 'More options' }))

    expect(within(dialog).queryByRole('button', { name: 'More options' })).toBeNull()
    const team = within(dialog).getByLabelText('Team')
    await waitFor(() => expect(team).toHaveFocus())
    expect(team).toHaveTextContent('Alpha')
    // Under More options the agent list is the chosen team's own.
    await waitFor(() => expect(within(dialog).getByLabelText('Agent')).toHaveTextContent('Ada'))
    expect(within(dialog).getByLabelText('Agent')).not.toHaveTextContent('Alpha')
    await user.type(within(dialog).getByLabelText(/Details/), 'Keep it short.')
    await user.click(within(dialog).getByRole('button', { name: 'Send to Ada' }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      title: 'Draft the launch announcement',
      description: 'Keep it short.',
      teamId: 'team-1',
      assigneeAgentId: 'ada',
    })
  })

  it('sends nothing on Enter until the task is written', async () => {
    seed()
    const posted = serve()
    const user = userEvent.setup()
    const { dialog, field, onClose } = renderDialog()

    await user.type(field, '   {Enter}')
    expect(within(dialog).getByRole('button', { name: /Send to/ })).toBeDisabled()
    expect(posted).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers the same agent picker on a one-agent team', async () => {
    useTeamStore.setState({ teams: [ALPHA], selectedTeamId: null })
    useFleetStore.setState({ agents: [{ id: 'coder', name: 'Coder', teamId: 'team-1' }] as never })
    serve({})
    const user = userEvent.setup()
    const { dialog } = renderDialog()

    const agent = within(dialog).getByLabelText('Agent')
    expect(agent).toHaveTextContent('Coder')
    expect(within(dialog).queryByTestId('new-task-suggestion')).toBeNull()
    await user.click(agent)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Coder'])
  })
})
