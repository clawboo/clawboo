// TeamSettingsSheet — the per-team brief + rules overlay. It had an Escape
// handler but no dialog semantics and no focus trap; both now come from the
// shared <Modal>. The backdrop test-id is asserted because it is referenced by
// name elsewhere and must survive the refactor.

import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import type { Team } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'

import { server } from '../../../__vitest__/mswServer'
import { TeamSettingsSheet } from '../TeamSettingsSheet'

afterEach(() => cleanup())

// The color-collection picker reads theme context.
const renderSheet = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const TEAM: Team = {
  id: 't1',
  name: 'Acme',
  icon: '🧪',
  color: '#3b82f6',
  colorCollectionId: null,
  templateId: null,
  agentCount: 2,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: true,
}

beforeEach(() => {
  server.use(
    http.get('/api/boo-zero/team-briefs/:teamId', () => HttpResponse.json({ brief: null })),
    http.get('/api/team-rules/:teamId', () => HttpResponse.json({ content: '' })),
  )
})

const noop = () => {}

describe('TeamSettingsSheet', () => {
  it('is a modal dialog named after the team', async () => {
    renderSheet(<TeamSettingsSheet team={TEAM} onClose={noop} />)
    const dialog = await screen.findByRole('dialog', { name: 'Acme — Settings' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('data-testid', 'team-settings-sheet')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderSheet(<TeamSettingsSheet team={TEAM} onClose={onClose} />)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a backdrop mousedown', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderSheet(<TeamSettingsSheet team={TEAM} onClose={onClose} />)
    await screen.findByRole('dialog')
    await user.click(screen.getByTestId('team-settings-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the close control reachable by name', async () => {
    renderSheet(<TeamSettingsSheet team={TEAM} onClose={noop} />)
    expect(await screen.findByRole('button', { name: 'Close team settings' })).toBeInTheDocument()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = renderSheet(<TeamSettingsSheet team={TEAM} onClose={noop} />)
    await screen.findByRole('dialog')
    expect(await axe(container)).toHaveNoViolations()
  })
})
