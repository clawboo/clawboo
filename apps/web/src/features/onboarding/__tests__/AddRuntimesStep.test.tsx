// AddRuntimesStep — the optional "add more runtimes" step. Renders the coding-
// runtime grid + the OpenClaw detour row; both Continue and Skip advance and
// nothing here can strand (the native team already exists by this point).

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
    onSkip: vi.fn(),
    onSetupOpenClaw: vi.fn(),
    openClawConnected: false,
    ...overrides,
  }
  render(<AddRuntimesStep {...props} />)
  return props
}

describe('AddRuntimesStep', () => {
  it('renders the coding-runtime cards + the OpenClaw setup row', async () => {
    noRuntimes()
    renderStep()
    expect(await screen.findByTestId('runtime-card-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-hermes')).toBeInTheDocument()
    // Native has its own primary path — it is NOT in the grid.
    expect(screen.queryByTestId('runtime-card-clawboo-native')).not.toBeInTheDocument()
    expect(screen.getByTestId('addruntimes-setup-openclaw')).toBeInTheDocument()
  })

  it('Continue and Skip both fire their handlers (neither strands)', async () => {
    noRuntimes()
    const props = renderStep()
    await screen.findByTestId('runtime-card-claude-code')
    await userEvent.click(screen.getByTestId('addruntimes-continue'))
    expect(props.onContinue).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByTestId('addruntimes-skip'))
    expect(props.onSkip).toHaveBeenCalledTimes(1)
  })

  it('the OpenClaw row enters the detour when not connected', async () => {
    noRuntimes()
    const props = renderStep({ openClawConnected: false })
    await userEvent.click(await screen.findByTestId('addruntimes-setup-openclaw'))
    expect(props.onSetupOpenClaw).toHaveBeenCalledTimes(1)
  })

  it('shows Connected (no setup button) once the OpenClaw detour succeeded', async () => {
    noRuntimes()
    renderStep({ openClawConnected: true })
    await screen.findByTestId('runtime-card-claude-code')
    expect(screen.queryByTestId('addruntimes-setup-openclaw')).not.toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
  })

  it('has no level-A/AA a11y violations', async () => {
    noRuntimes()
    const { container } = render(
      <AddRuntimesStep
        onContinue={vi.fn()}
        onSkip={vi.fn()}
        onSetupOpenClaw={vi.fn()}
        openClawConnected={false}
      />,
    )
    await screen.findByTestId('runtime-card-claude-code')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
