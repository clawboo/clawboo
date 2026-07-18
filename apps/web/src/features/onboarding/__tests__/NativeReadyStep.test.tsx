// NativeReadyStep — the in-wizard "Your team is ready" landing. RTL pattern
// (msw onUnhandledRequest:'error' + jest-dom + userEvent). Fetches the roster +
// Boo Zero from /api/agents and renders the SHARED `MeetYourTeamCard` (the same
// card the marketplace path shows in the gate); a SINGLE primary action enters
// the dashboard (the competing "Capabilities" exit was removed in the
// native-first reframe).

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
// `defaultId` is the server's resolved Boo Zero — teamless by design, so it must
// drive the "Led by" badge WITHOUT appearing in the team roster.
const AGENTS = {
  defaultId: 'native-bz',
  mainKey: 'main',
  stale: false,
  lastSyncedAt: null,
  agents: [
    { id: 'native-bz', displayName: 'Boo Zero', teamId: null },
    { id: 'native-lead-1', displayName: 'Captain Boo', teamId: 'team-1' },
    { id: 'native-coder-1', displayName: 'Pixel Boo', teamId: 'team-1' },
    { id: 'other', displayName: 'Stranger Boo', teamId: 'team-2' },
  ],
}

describe('NativeReadyStep', () => {
  it('renders the deployed roster', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    expect(await screen.findByText('Captain Boo')).toBeInTheDocument()
    expect(screen.getByText('Pixel Boo')).toBeInTheDocument()
    // Agent from a different team is not shown.
    expect(screen.queryByText('Stranger Boo')).not.toBeInTheDocument()
  })

  it('shows the "Led by Boo Zero" badge, and keeps teamless Boo Zero OUT of the roster', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    const badge = await screen.findByTestId('led-by-boo-zero-badge')
    expect(badge).toHaveTextContent(/Led by\s*Boo Zero/)
    // Boo Zero is teamless: it belongs in the badge, never as a roster member.
    // (A `?teamId=` server-side filter would drop it entirely — hence the
    // unfiltered fetch + client-side roster filter.)
    expect(screen.getByText('Boo Zero')).toBe(
      badge.querySelector('strong') as unknown as HTMLElement,
    )
  })

  it('renders WITHOUT the badge when Boo Zero cannot be resolved', async () => {
    // A no-key / pure-OpenClaw install materializes no native Boo Zero; the card
    // must degrade to the sparkle fallback rather than claim a leader.
    server.use(
      http.get('/api/agents', () =>
        HttpResponse.json({ ...AGENTS, defaultId: '', agents: AGENTS.agents.slice(1) }),
      ),
    )
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    await screen.findByText('Captain Boo')
    expect(screen.queryByTestId('led-by-boo-zero-badge')).not.toBeInTheDocument()
  })

  it('drops the architecture info boxes (the card carries the framing now)', async () => {
    server.use(http.get('/api/agents', () => HttpResponse.json(AGENTS)))
    render(<NativeReadyStep teamId="team-1" onOpenDashboard={vi.fn()} />)
    await screen.findByText('Captain Boo')
    expect(screen.queryByText(/share one memory/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/as peers anytime/i)).not.toBeInTheDocument()
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
