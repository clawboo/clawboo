// NativeReadyStep — the in-wizard "Your team is ready" landing. RTL pattern
// (msw onUnhandledRequest:'error' + jest-dom + userEvent). Fetches the seeded
// roster from /api/agents; the primary action enters the dashboard, the
// secondary one routes to Capabilities.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useViewStore } from '@/stores/view'
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
    render(
      <NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} onOpenCapabilities={vi.fn()} />,
    )
    expect(await screen.findByText('Captain Boo')).toBeInTheDocument()
    expect(screen.getByText('Pixel Boo')).toBeInTheDocument()
    // Agent from a different team is not shown.
    expect(screen.queryByText('Stranger Boo')).not.toBeInTheDocument()
    expect(screen.getByText(/share one memory/i)).toBeInTheDocument()
  })

  it('Open my dashboard fires onOpenDashboard', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    const onOpenDashboard = vi.fn()
    render(
      <NativeReadyStep
        teamId="team-1"
        onOpenDashboard={onOpenDashboard}
        onOpenCapabilities={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByTestId('native-open-dashboard'))
    expect(onOpenDashboard).toHaveBeenCalledTimes(1)
  })

  it('Capabilities link navigates to the Capabilities view + fires onOpenCapabilities', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    const onOpenCapabilities = vi.fn()
    render(
      <NativeReadyStep
        teamId="team-1"
        onOpenDashboard={vi.fn()}
        onOpenCapabilities={onOpenCapabilities}
      />,
    )
    await userEvent.click(screen.getByTestId('native-open-capabilities'))
    await waitFor(() => expect(onOpenCapabilities).toHaveBeenCalledTimes(1))
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'capabilities' })
  })

  it('has no level-A/AA a11y violations', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    const { container } = render(
      <NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} onOpenCapabilities={vi.fn()} />,
    )
    await screen.findByText('Captain Boo')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
