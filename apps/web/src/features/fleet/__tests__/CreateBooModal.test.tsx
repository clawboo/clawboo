// CreateBooModal — dialog semantics + the keyboard contract it never had.
//
// Two of these guard specific regressions the <Modal> adoption fixed:
//   • Escape used to be an `onKeyDown` on a NON-focusable backdrop div, so it
//     silently did nothing whenever focus sat on <body> (the default, since
//     there was no focus trap to move it in).
//   • The name input was focused by a bare `setTimeout(…, 100)`. That timeout is
//     gone — the focus trap lands on the panel's first focusable, which IS the
//     name input. If someone re-orders the fields, this test fails.
//
// The second block covers the runtime the Boo is made on: OpenClaw while its
// Gateway is connected, Clawboo Native without one.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'

import { CreateBooModal } from '../CreateBooModal'

// The create path is stubbed so a test can hold it in flight, and so the
// runtime tests can read what it was asked to create.
const { createAgentMock } = vi.hoisted(() => ({ createAgentMock: vi.fn() }))
vi.mock('@/lib/createAgent', () => ({ createAgent: createAgentMock }))

afterEach(() => {
  cleanup()
  createAgentMock.mockReset()
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: '' })
})

const noop = () => {}

describe('CreateBooModal', () => {
  it('is a labelled modal dialog', () => {
    render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    const dialog = screen.getByRole('dialog', { name: 'Create a new Boo' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('renders nothing when closed', () => {
    render(<CreateBooModal isOpen={false} onClose={noop} onCreated={noop} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus to the Name field on open', async () => {
    render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus())
  })

  it('associates both field labels with their controls', () => {
    render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    expect(screen.getByLabelText('Name')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Role (optional)').tagName).toBe('TEXTAREA')
  })

  it('closes on Escape even when focus has not been moved by hand', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<CreateBooModal isOpen onClose={onClose} onCreated={noop} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a scrim mousedown but not on a panel mousedown', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(<CreateBooModal isOpen onClose={onClose} onCreated={noop} />)

    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(container.querySelector('[role="presentation"]') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Cancel is disabled while the write runs, which states the intent. Escape and
  // the scrim have to honour it too, or the dialog vanishes while createAgent and
  // the follow-up POSTs keep going and the agent appears anyway.
  it('ignores Escape and the scrim while a create is in flight', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    // Never resolves, so `creating` stays true for the duration of the test.
    createAgentMock.mockImplementation(() => new Promise<string>(() => {}))
    useConnectionStore.setState({ status: 'connected', client: {} as never, gatewayUrl: '' })

    const { container } = render(<CreateBooModal isOpen onClose={onClose} onCreated={noop} />)
    await user.type(screen.getByLabelText('Name'), 'Scout')
    await user.click(screen.getByRole('button', { name: 'Create Boo' }))
    await waitFor(() => expect(createAgentMock).toHaveBeenCalled())

    await user.keyboard('{Escape}')
    await user.click(container.querySelector('[role="presentation"]') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<CreateBooModal isOpen onClose={noop} onCreated={noop} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('CreateBooModal runtime', () => {
  let assigned: { teamId: string; body: unknown } | null = null

  beforeEach(() => {
    assigned = null
    createAgentMock.mockResolvedValue('a-new')
    useTeamStore.setState({ selectedTeamId: 't1' })
    server.use(
      http.post('/api/personality', () => HttpResponse.json({ ok: true })),
      http.post('/api/teams/:teamId/agents', async ({ params, request }) => {
        assigned = { teamId: String(params['teamId']), body: await request.json() }
        return HttpResponse.json({ ok: true })
      }),
    )
  })

  afterEach(() => useTeamStore.setState({ selectedTeamId: null }))

  /** Open the dialog, check the runtime it names, then create "Scout". */
  async function createScout(hint: string) {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    const onClose = vi.fn()
    render(<CreateBooModal isOpen onClose={onClose} onCreated={onCreated} />)
    expect(await screen.findByTestId('create-boo-runtime')).toHaveTextContent(hint)
    await user.type(screen.getByLabelText('Name'), 'Scout')
    await user.click(screen.getByRole('button', { name: 'Create Boo' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('a-new'))
    expect(onClose).toHaveBeenCalled()
  }

  // Native mode: the app is connected, with no Gateway client and none on the
  // server either (the default registry-health answer).
  it('makes a Clawboo Native Boo with no Gateway, in the selected team', async () => {
    useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
    await createScout('Runs on Clawboo Native: no OpenClaw Gateway is connected.')
    expect(createAgentMock).toHaveBeenCalledWith(
      'Scout',
      expect.objectContaining({ soul: expect.stringContaining('# SOUL') }),
      'clawboo-native',
    )
    expect(assigned).toEqual({ teamId: 't1', body: { agentId: 'a-new' } })
    expect(screen.queryByText(/Not connected to Gateway/)).toBeNull()
  })

  it('makes an OpenClaw Boo while the Gateway is connected', async () => {
    useConnectionStore.setState({ status: 'connected', client: {} as never, gatewayUrl: '' })
    await createScout('Runs on OpenClaw, through your Gateway.')
    expect(createAgentMock).toHaveBeenCalledWith('Scout', expect.any(Object), 'openclaw')
    expect(assigned).toEqual({ teamId: 't1', body: { agentId: 'a-new' } })
  })

  // A thin client has no Gateway connection of its own, only the server's.
  it("makes an OpenClaw Boo when only the server's Gateway connection is up", async () => {
    server.use(
      http.get('/api/agents/registry/health', () =>
        HttpResponse.json({ ok: true, connection: 'connected', lastSyncedAt: null }),
      ),
    )
    useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
    await createScout('Runs on OpenClaw, through your Gateway.')
    expect(createAgentMock).toHaveBeenCalledWith('Scout', expect.any(Object), 'openclaw')
  })
})
