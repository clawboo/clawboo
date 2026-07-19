// AddRuntimesStep — the optional "add more runtimes" step. Renders ONE connect
// LIST (RuntimeConnectList): the connected native foundation, the coding-runtime
// rows, and an OpenClaw row into the Gateway detour. Each unconnected row shows
// an explicit state-aware CTA (Connect / Install / Sign in / Set up) that IS the
// disclosure toggle — clicking it expands the connect flow in place; there is no
// chevron and no status pill. The connect body stays MOUNTED when collapsed so a
// background install survives. A single Continue advances (there is no separate
// "skip"), and nothing here can strand (the native runtime is already connected).

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { AddRuntimesStep } from '../steps/AddRuntimesStep'

afterEach(() => cleanup())

const noRuntimes = () =>
  server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))

function renderStep(overrides: Partial<Parameters<typeof AddRuntimesStep>[0]> = {}) {
  const props = {
    onContinue: vi.fn(),
    onBack: vi.fn(),
    onOpenClawConnected: vi.fn(),
    openClawConnected: false,
    ...overrides,
  }
  render(<AddRuntimesStep {...props} />)
  return props
}

describe('AddRuntimesStep', () => {
  it('lists every runtime as a row, each unconnected row with an explicit CTA toggle (no pill, no chevron)', async () => {
    noRuntimes()
    renderStep()
    // Native is the already-connected foundation: its only affordance is the
    // Manage toggle revealing the READ-ONLY provider list (connected keys).
    const nativeRow = await screen.findByTestId('runtime-list-row-clawboo-native')
    expect(nativeRow.tagName).toBe('DIV')
    expect(screen.getByTestId('runtime-list-row-clawboo-native-toggle')).toBeInTheDocument()
    // Wait for the first runtimes fetch to settle — until then rows show a
    // neutral placeholder rather than a premature "Connect" affordance.
    await screen.findByTestId('runtime-list-row-claude-code-toggle')
    // Every addable runtime is a visible row with an explicit CTA toggle — the
    // fix for "no call-to-action, users cannot find the chevron".
    for (const id of ['claude-code', 'codex', 'hermes', 'openclaw']) {
      expect(screen.getByTestId(`runtime-list-row-${id}`)).toBeInTheDocument()
      const toggle = screen.getByTestId(`runtime-list-row-${id}-toggle`)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }
    // The OpenClaw CTA reads "Set up" (its accessible name), not a "NOT SET UP" pill.
    expect(screen.getByTestId('runtime-list-row-openclaw-toggle')).toHaveAccessibleName(
      /set up openclaw/i,
    )
    expect(screen.queryByText('Not set up')).not.toBeInTheDocument()
    // Connect bodies are all MOUNTED from the start (background installs survive).
    expect(screen.getByTestId('runtime-card-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-hermes')).toBeInTheDocument()
  })

  it('the CTA toggle expands the row in place to reveal its connect flow', async () => {
    noRuntimes()
    renderStep()
    const toggle = await screen.findByTestId('runtime-list-row-codex-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'runtime-list-row-codex-body')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Once open, the toggle flips to a "Close" collapse affordance (no chevron).
    expect(toggle).toHaveAccessibleName(/collapse codex/i)
    // The card stayed mounted throughout.
    expect(screen.getByTestId('runtime-card-codex')).toBeInTheDocument()
  })

  it('Continue advances (the single forward action)', async () => {
    noRuntimes()
    const props = renderStep()
    await userEvent.click(await screen.findByTestId('addruntimes-continue'))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
    // The redundant "skip" button is gone.
    expect(screen.queryByTestId('addruntimes-skip')).not.toBeInTheDocument()
  })

  it('the OpenClaw CTA runs setup IN-PLACE (no navigation to another page)', async () => {
    noRuntimes()
    // No connected provider → the inline setup stops at its compact key prompt.
    server.use(
      http.post('/api/system/auto-configure-openclaw', () =>
        HttpResponse.json({ ok: false, needsKey: true }),
      ),
    )
    renderStep({ openClawConnected: false })
    await userEvent.click(await screen.findByTestId('runtime-list-row-openclaw-toggle'))
    await userEvent.click(screen.getByTestId('addruntimes-setup-openclaw'))
    // The setup renders inside the row — no separate page.
    expect(await screen.findByTestId('openclaw-inline-setup')).toBeInTheDocument()
    // still within the add-runtimes step (the other rows are still there)
    expect(screen.getByTestId('runtime-list-row-claude-code')).toBeInTheDocument()
  })

  it('a connected runtime shows the premium Connected indicator, not the old pill', async () => {
    noRuntimes()
    renderStep({ openClawConnected: true })
    await screen.findByTestId('runtime-list-row-openclaw')
    // Connected settles to the indicator: no setup button, no toggle, no pill.
    expect(screen.queryByTestId('addruntimes-setup-openclaw')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-list-row-openclaw-toggle')).not.toBeInTheDocument()
    // Both the native foundation and OpenClaw read a sentence-case "Connected".
    const connected = screen.getAllByText('Connected')
    expect(connected.length).toBeGreaterThanOrEqual(2)
    // ...and it is NOT the uppercase mono pill class.
    for (const el of connected) expect(el).not.toHaveClass('uppercase')
  })

  it('has no level-A/AA a11y violations', async () => {
    noRuntimes()
    const { container } = render(
      <AddRuntimesStep
        onContinue={vi.fn()}
        onBack={vi.fn()}
        onOpenClawConnected={vi.fn()}
        openClawConnected={false}
      />,
    )
    await screen.findByTestId('runtime-list-row-claude-code')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
