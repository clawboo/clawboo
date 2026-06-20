// OnboardingWizard — wizard-level behaviour the per-step tests can't cover:
//   1. a coding-agent FIRST choice (Claude Code) completes onboarding directly
//      (client-free 'native' landing) instead of entering the Gateway-only
//      team → deploy flow it could never finish — the dead-end fix.
//   2. the modal announces itself as a dialog, traps + restores focus, and
//      Escape steps back one step (no-op on the first step) — the a11y fix.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { OnboardingWizard } from '../OnboardingWizard'

// Fake GatewayClient (records the disconnect spy) so the OpenClaw connect path
// can be driven without a real WebSocket. The module's other exports stay real.
const { fakeDisconnect } = vi.hoisted(() => ({ fakeDisconnect: vi.fn() }))
vi.mock('@clawboo/gateway-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/gateway-client')>()
  class FakeGatewayClient {
    connect = vi.fn().mockResolvedValue(undefined)
    disconnect = fakeDisconnect
  }
  return { ...actual, GatewayClient: FakeGatewayClient }
})

afterEach(() => cleanup())

describe('OnboardingWizard — coding-agent first run is not a dead-end', () => {
  it('Claude Code → ConnectAgents → Skip completes onboarding client-free (no team)', async () => {
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="chooseRuntime" />)

    await userEvent.click(screen.getByTestId('runtime-pick-claude-code'))
    await userEvent.click(await screen.findByTestId('connect-agents-skip'))

    // No GatewayClient, no team — lands in the dashboard via the native path.
    expect(onComplete).toHaveBeenCalledWith(null, null, null, 'native')
  })

  it('Claude Code → ConnectAgents → Continue also completes client-free', async () => {
    server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="chooseRuntime" />)

    await userEvent.click(screen.getByTestId('runtime-pick-codex'))
    await userEvent.click(await screen.findByTestId('connect-agents-continue'))

    expect(onComplete).toHaveBeenCalledWith(null, null, null, 'native')
  })
})

describe('OnboardingWizard — a11y (dialog + focus trap + Escape-as-back)', () => {
  it('announces a modal dialog', () => {
    render(<OnboardingWizard onComplete={vi.fn()} initialStep="chooseRuntime" />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-label', 'Set up Clawboo')
  })

  // The focus-trap falls back to focusing the dialog root on a control-less
  // step; an element without tabindex isn't a valid focus target, so the root
  // must carry tabIndex={-1} for that fallback to actually move focus.
  it('makes the dialog root focusable (tabIndex=-1)', () => {
    render(<OnboardingWizard onComplete={vi.fn()} initialStep="chooseRuntime" />)
    expect(screen.getByRole('dialog')).toHaveAttribute('tabindex', '-1')
  })

  it('moves focus into the dialog on open and restores it on close', async () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          <button data-testid="outside">outside</button>
          {show ? <OnboardingWizard onComplete={vi.fn()} initialStep="chooseRuntime" /> : null}
        </>
      )
    }
    const { rerender } = render(<Harness show={false} />)
    const outside = screen.getByTestId('outside')
    outside.focus()
    expect(outside).toHaveFocus()

    rerender(<Harness show />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    rerender(<Harness show={false} />)
    await waitFor(() => expect(outside).toHaveFocus())
  })

  it('Escape steps back one step, and is a no-op on the first step', async () => {
    render(<OnboardingWizard onComplete={vi.fn()} initialStep="configureNative" />)
    await screen.findByTestId('configure-native-step')

    // configureNative → chooseRuntime
    await userEvent.keyboard('{Escape}')
    expect(await screen.findByTestId('choose-runtime-step')).toBeInTheDocument()

    // chooseRuntime is the first real step — Escape is a no-op.
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('choose-runtime-step')).toBeInTheDocument()
  })
})

describe('OnboardingWizard — escaping the OpenClaw path resets the client', () => {
  beforeEach(() => {
    fakeDisconnect.mockClear()
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ gatewayUrl: '', hasToken: false })),
      http.post('/api/settings', () => HttpResponse.json({})),
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
    )
  })

  it('connect → Escape to chooseRuntime → re-pick Claude Code completes client-free (no team)', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="connect" />)

    // Establish a GatewayClient via the OpenClaw connect step.
    await userEvent.click(await screen.findByRole('button', { name: /^Connect/ }))
    // Lands on ConnectAgents WITH a live client.
    await screen.findByTestId('connect-agents-step')

    // Escape retreats to the runtime picker — the client must be torn down.
    await userEvent.keyboard('{Escape}')
    await screen.findByTestId('choose-runtime-step')
    expect(fakeDisconnect).toHaveBeenCalled()

    // Re-pick a coding agent: with the client cleared, the step is terminal and
    // completes onboarding client-free — NOT routed into the team→deploy flow.
    await userEvent.click(screen.getByTestId('runtime-pick-claude-code'))
    await userEvent.click(await screen.findByTestId('connect-agents-skip'))

    expect(onComplete).toHaveBeenCalledWith(null, null, null, 'native')
  })
})
