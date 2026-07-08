// OnboardingWizard — wizard-level behaviour the per-step tests can't cover:
//   1. the native-first spine (welcome → configureNative → addRuntimes →
//      nativeReady) runs end-to-end and completes client-free — no strand.
//   2. Skip on addRuntimes still completes (both Continue + Skip land nativeReady).
//   3. the OpenClaw detour hands a live client back through as 'gateway' mode
//      (never discarded) — and returns to addRuntimes, not a team/deploy flow.
//   4. the modal announces itself as a dialog, traps + restores focus, and
//      Escape steps back one step (no-op on welcome) — the a11y contract.

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

// The native-seed path: connect the key (vault write) + seed the starter team.
function useNativeSeedHandlers() {
  server.use(
    http.post('/api/runtimes/clawboo-native/connect', () => HttpResponse.json({ ok: true })),
    http.post('/api/onboarding/seed-native-team', () =>
      HttpResponse.json({ teamId: 'team-1', leaderAgentId: 'lead', specialistAgentId: 'coder' }),
    ),
    http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
    http.get('/api/agents', () =>
      HttpResponse.json({ agents: [{ id: 'lead', displayName: 'Team Lead', teamId: 'team-1' }] }),
    ),
  )
}

afterEach(() => cleanup())

describe('OnboardingWizard — native-first spine', () => {
  beforeEach(() => useNativeSeedHandlers())

  async function seedNativeTeam() {
    // configureNative: paste a key, create the team → advances to addRuntimes.
    await userEvent.type(await screen.findByTestId('native-api-key'), 'sk-ant-test')
    await userEvent.click(screen.getByTestId('native-create-team'))
    await screen.findByTestId('add-runtimes-step')
  }

  it('configureNative → addRuntimes → Skip → nativeReady → completes native (no strand)', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="configureNative" />)

    await seedNativeTeam()
    await userEvent.click(screen.getByTestId('addruntimes-skip'))
    await userEvent.click(await screen.findByTestId('native-open-dashboard'))

    // Client-free native landing, in the seeded team — never stranded.
    expect(onComplete).toHaveBeenCalledWith(null, null, 'team-1', 'native')
  })

  it('Continue on addRuntimes also completes (symmetric with Skip)', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="configureNative" />)

    await seedNativeTeam()
    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    await userEvent.click(await screen.findByTestId('native-open-dashboard'))

    expect(onComplete).toHaveBeenCalledWith(null, null, 'team-1', 'native')
  })
})

describe('OnboardingWizard — the OpenClaw detour hands a live client through', () => {
  beforeEach(() => {
    fakeDisconnect.mockClear()
    server.use(
      http.get('/api/settings', () => HttpResponse.json({ gatewayUrl: '', hasToken: false })),
      http.post('/api/settings', () => HttpResponse.json({})),
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
      // nativeReady fetches the roster once we land there.
      http.get('/api/agents', () => HttpResponse.json({ agents: [] })),
    )
  })

  it('connect → returns to addRuntimes → Continue → nativeReady completes as gateway', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="connect" />)

    // Establish a GatewayClient via the OpenClaw ConnectStep (detour).
    await userEvent.click(await screen.findByRole('button', { name: /^Connect/ }))
    // The detour returns to addRuntimes (NOT a team/deploy flow) with a live client.
    await screen.findByTestId('add-runtimes-step')
    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    await userEvent.click(await screen.findByTestId('native-open-dashboard'))

    // The live client is preserved (gateway mode), not discarded.
    const call = onComplete.mock.calls[0]
    expect(call?.[0]).toBeTruthy()
    expect(call?.[3]).toBe('gateway')
  })
})

describe('OnboardingWizard — a11y (dialog + focus trap + Escape-as-back)', () => {
  beforeEach(() => useNativeSeedHandlers())

  it('announces a modal dialog', () => {
    render(<OnboardingWizard onComplete={vi.fn()} initialStep="configureNative" />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-label', 'Set up Clawboo')
  })

  // The focus-trap falls back to focusing the dialog root on a control-less
  // step; an element without tabindex isn't a valid focus target, so the root
  // must carry tabIndex={-1} for that fallback to actually move focus.
  it('makes the dialog root focusable (tabIndex=-1)', () => {
    render(<OnboardingWizard onComplete={vi.fn()} initialStep="configureNative" />)
    expect(screen.getByRole('dialog')).toHaveAttribute('tabindex', '-1')
  })

  it('moves focus into the dialog on open and restores it on close', async () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          <button data-testid="outside">outside</button>
          {show ? <OnboardingWizard onComplete={vi.fn()} initialStep="configureNative" /> : null}
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

  it('Escape steps configureNative back to welcome; welcome ignores Escape', async () => {
    render(<OnboardingWizard onComplete={vi.fn()} initialStep="configureNative" />)
    await screen.findByTestId('configure-native-step')

    // configureNative → welcome
    await userEvent.keyboard('{Escape}')
    expect(await screen.findByRole('button', { name: /Get Started/ })).toBeInTheDocument()

    // welcome is the first step — Escape is a no-op.
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: /Get Started/ })).toBeInTheDocument()
  })
})
