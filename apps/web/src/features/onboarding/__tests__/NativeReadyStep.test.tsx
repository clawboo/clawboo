// NativeReadyStep — the in-wizard "Your team is ready" landing. RTL pattern
// (msw onUnhandledRequest:'error' + jest-dom + userEvent). Fetches the seeded
// roster from /api/agents; a SINGLE primary action enters the dashboard (the
// competing "Capabilities" exit was removed in the native-first reframe).

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { NativeReadyStep } from '../steps/NativeReadyStep'

afterEach(() => cleanup())

// Distinct from the component's fallback names ("Team Lead" / "Coder") so the
// assertions only match the SETTLED fetch, not the pre-fetch fallback.
const AGENTS = {
  agents: [
    { id: 'native-lead-1', displayName: 'Captain Boo', teamId: 'team-1' },
    { id: 'native-coder-1', displayName: 'Pixel Boo', teamId: 'team-1' },
    { id: 'other', displayName: 'Stranger Boo', teamId: 'team-2' },
  ],
}

describe('NativeReadyStep', () => {
  it('renders the seeded roster + the shared-memory framing', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    expect(await screen.findByText('Captain Boo')).toBeInTheDocument()
    expect(screen.getByText('Pixel Boo')).toBeInTheDocument()
    // Agent from a different team is not shown.
    expect(screen.queryByText('Stranger Boo')).not.toBeInTheDocument()
    expect(screen.getByText(/share one memory/i)).toBeInTheDocument()
  })

  it('Open my dashboard fires onOpenDashboard', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    const onOpenDashboard = vi.fn()
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={onOpenDashboard} />)
    await userEvent.click(screen.getByTestId('native-open-dashboard'))
    expect(onOpenDashboard).toHaveBeenCalledTimes(1)
  })

  it('has a SINGLE primary CTA — no competing Capabilities exit', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    await screen.findByText('Captain Boo')
    expect(screen.getByTestId('native-open-dashboard')).toBeInTheDocument()
    expect(screen.queryByTestId('native-open-capabilities')).not.toBeInTheDocument()
    // Exactly one interactive control in the step (the dashboard CTA).
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    const { container } = render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    await screen.findByText('Captain Boo')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
