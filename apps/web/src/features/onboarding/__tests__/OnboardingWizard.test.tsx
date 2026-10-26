// OnboardingWizard — wizard-level behaviour the per-step tests can't cover:
//   1. the native-first spine (welcome → configureNative → addRuntimes →
//      selectTeam → nativeReady) runs end-to-end and completes client-free — no
//      strand. Runtimes come BEFORE team so a connected runtime is assignable to a
//      team agent. The real deploy engine (CreateTeamModal) is mocked here (it has
//      its own tests); this asserts the WIRING: a deploy advances the wizard with
//      the deployed team id.
//   2. Skip on addRuntimes still completes (both Continue + Skip land nativeReady).
//   3. a live client from the in-place OpenClaw setup on addRuntimes is handed
//      through as 'gateway' mode (never discarded), and Escape from selectTeam
//      back to addRuntimes keeps it connected.
//   4. the modal announces itself as a dialog, traps + restores focus, and
//      Escape steps back one step (no-op on welcome) — the a11y contract.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { OnboardingWizard } from '../OnboardingWizard'

// The OpenClaw setup connects through the saved-settings helper; fake it so the
// connect path runs without a real WebSocket. The disconnect spy proves the
// wizard never tears the client down.
const { fakeDisconnect } = vi.hoisted(() => ({ fakeDisconnect: vi.fn() }))
vi.mock('@/lib/gatewayConnect', () => ({
  connectGatewayFromSettings: vi.fn(async () => ({
    client: { disconnect: fakeDisconnect },
    gatewayUrl: 'ws://localhost:18789',
  })),
}))

// The real team-deploy engine is exercised by CreateTeamModal's own tests; here
// it's a minimal fake that, while open, exposes a "deploy" button reporting a
// team id — so the wizard test drives the spine without the deploy machinery.
vi.mock('@/features/teams/CreateTeamModal', () => ({
  CreateTeamModal: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean
    onCreated: (teamId?: string) => void
  }) =>
    isOpen ? (
      <button data-testid="fake-deploy" type="button" onClick={() => onCreated('team-1')}>
        deploy
      </button>
    ) : null,
}))

// The native connect path: verify the key, write the vault key + record the
// leader model. The healthcheck is what Continue runs BEFORE it stores anything,
// so the spine can't advance without a verdict.
function useNativeConnectHandlers() {
  server.use(
    http.post('/api/runtimes/clawboo-native/healthcheck', () => HttpResponse.json({ ok: true })),
    http.post('/api/runtimes/clawboo-native/connect', () => HttpResponse.json({ ok: true })),
    http.post('/api/onboarding/native-leader-model', () => HttpResponse.json({ ok: true })),
    http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
    http.get('/api/agents', () =>
      HttpResponse.json({ agents: [{ id: 'lead', displayName: 'Team Lead', teamId: 'team-1' }] }),
    ),
  )
}

afterEach(() => cleanup())

describe('OnboardingWizard — native-first spine', () => {
  beforeEach(() => useNativeConnectHandlers())

  // configureNative: paste a key, continue → addRuntimes (runtimes come first now).
  async function connectToAddRuntimes() {
    // OpenAI is the default card (ChatGPT sign-in, no key field); pick a key provider.
    await userEvent.click(await screen.findByTestId('native-provider-anthropic'))
    await userEvent.type(await screen.findByTestId('native-api-key'), 'sk-ant-test')
    await userEvent.click(screen.getByTestId('native-continue'))
    await screen.findByTestId('add-runtimes-step')
  }

  // selectTeam: the (mocked) team marketplace auto-opens; deploy a real team.
  //
  // The deploy engine is reached through `CreateTeamModalLazy`, a React.lazy boundary
  // that keeps the marketplace surfaces off the SPA entry chunk (issue #83). The
  // step therefore paints a Suspense fallback and swaps in the (mocked) modal a tick
  // later, on top of the wizard's own step transition — more than RTL's 1 s `findBy`
  // default reliably absorbs on a loaded machine, so give this one an explicit budget.
  async function deployTeamThenLand() {
    await userEvent.click(await screen.findByTestId('fake-deploy', {}, { timeout: 8_000 }))
    await userEvent.click(await screen.findByTestId('native-open-dashboard'))
  }

  it('configureNative → addRuntimes → Continue → selectTeam (deploy) → nativeReady → completes native (no strand)', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="configureNative" />)

    // Add-runtimes is optional; Continue is the single forward action (works
    // whether or not anything was connected).
    await connectToAddRuntimes()
    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    await deployTeamThenLand()

    // Client-free native landing, in the DEPLOYED team — never stranded.
    expect(onComplete).toHaveBeenCalledWith(null, null, 'team-1', 'native')
  })
})

describe('OnboardingWizard: the OpenClaw setup hands a live client through', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })),
      // The inline setup reuses a connected key, finds OpenClaw installed and
      // starts the Gateway, then connects.
      http.post('/api/system/auto-configure-openclaw', () =>
        HttpResponse.json({ ok: true, gatewayUrl: 'ws://localhost:18789', provider: 'anthropic' }),
      ),
      http.get('/api/system/status', () => HttpResponse.json({ openclaw: { installed: true } })),
      http.post(
        '/api/system/gateway',
        () =>
          new HttpResponse('data: {"type":"complete","success":true}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
      ),
      // nativeReady fetches the roster once we land there.
      http.get('/api/agents', () => HttpResponse.json({ agents: [] })),
    )
  })

  // Set up OpenClaw in place on its row; once the wizard holds the live client
  // the row settles to Connected.
  async function setUpOpenClaw() {
    await userEvent.click(await screen.findByTestId('runtime-list-row-openclaw-toggle'))
    await userEvent.click(screen.getByTestId('addruntimes-setup-openclaw'))
    await within(screen.getByTestId('runtime-list-row-openclaw')).findByText('Connected')
  }

  async function deployAndLand() {
    await userEvent.click(await screen.findByTestId('fake-deploy', {}, { timeout: 8_000 }))
    await userEvent.click(await screen.findByTestId('native-open-dashboard'))
  }

  function expectGatewayCompletion(onComplete: ReturnType<typeof vi.fn>) {
    const call = onComplete.mock.calls[0]
    expect(call?.[0]).toBeTruthy()
    expect(call?.[1]).toBe('ws://localhost:18789')
    expect(call?.[3]).toBe('gateway')
  }

  it('addRuntimes OpenClaw setup → Continue → selectTeam → nativeReady completes as gateway', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="addRuntimes" />)

    await setUpOpenClaw()
    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    await deployAndLand()

    // The live client is preserved (gateway mode), not discarded.
    expectGatewayCompletion(onComplete)
  })

  it('Escape from selectTeam back to addRuntimes keeps the OpenClaw client connected', async () => {
    fakeDisconnect.mockClear()
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} initialStep="addRuntimes" />)

    await setUpOpenClaw()
    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    await screen.findByTestId('fake-deploy', {}, { timeout: 8_000 })

    await userEvent.keyboard('{Escape}')
    await screen.findByTestId('add-runtimes-step')
    expect(fakeDisconnect).not.toHaveBeenCalled()
    expect(
      within(screen.getByTestId('runtime-list-row-openclaw')).getByText('Connected'),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    await deployAndLand()
    expectGatewayCompletion(onComplete)
  })
})

describe('OnboardingWizard — a11y (dialog + focus trap + Escape-as-back)', () => {
  beforeEach(() => useNativeConnectHandlers())

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
