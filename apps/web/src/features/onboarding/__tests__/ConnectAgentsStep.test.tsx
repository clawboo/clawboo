// ConnectAgentsStep — the optional onboarding step. Renders the three runtime
// cards + Continue/Skip, both advancing to team setup. RTL pattern with msw
// (onUnhandledRequest:'error').

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { ConnectAgentsStep } from '../steps/ConnectAgentsStep'

beforeEach(() => {
  server.use(http.get('/api/runtimes', () => HttpResponse.json({ runtimes: [], available: [] })))
})
afterEach(() => cleanup())

describe('ConnectAgentsStep', () => {
  it('renders the three runtime cards + Continue/Skip', async () => {
    render(<ConnectAgentsStep onContinue={vi.fn()} onSkip={vi.fn()} />)
    expect(await screen.findByTestId('connect-agents-step')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-claude-code')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-codex')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-card-hermes')).toBeInTheDocument()
    expect(screen.getByTestId('connect-agents-continue')).toBeInTheDocument()
    expect(screen.getByTestId('connect-agents-skip')).toBeInTheDocument()
  })

  it('Continue advances to team setup', async () => {
    const onContinue = vi.fn()
    render(<ConnectAgentsStep onContinue={onContinue} onSkip={vi.fn()} />)
    await userEvent.click(await screen.findByTestId('connect-agents-continue'))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('Skip advances to team setup', async () => {
    const onSkip = vi.fn()
    render(<ConnectAgentsStep onContinue={vi.fn()} onSkip={onSkip} />)
    await userEvent.click(await screen.findByTestId('connect-agents-skip'))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(<ConnectAgentsStep onContinue={vi.fn()} onSkip={vi.fn()} />)
    await screen.findByTestId('connect-agents-step')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })

  // The 3-beat Setup/Team/Deploy indicator is only honest on the OpenClaw
  // continuation (which goes on to team → deploy). The terminal coding-agent
  // path completes onboarding here, so it must not promise those beats.
  it('shows the Setup/Team/Deploy beats when it continues to team setup', async () => {
    render(<ConnectAgentsStep onContinue={vi.fn()} onSkip={vi.fn()} continuesToTeam />)
    await screen.findByTestId('connect-agents-step')
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.getByText('Deploy')).toBeInTheDocument()
  })

  it('omits the Team/Deploy beats on the terminal coding-agent path', async () => {
    render(<ConnectAgentsStep onContinue={vi.fn()} onSkip={vi.fn()} continuesToTeam={false} />)
    await screen.findByTestId('connect-agents-step')
    expect(screen.queryByText('Team')).toBeNull()
    expect(screen.queryByText('Deploy')).toBeNull()
  })
})
