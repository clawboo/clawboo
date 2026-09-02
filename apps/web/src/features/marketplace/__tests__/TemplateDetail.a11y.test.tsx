// The two marketplace detail sheets. They were near-byte-identical hand-rolled
// overlays with no dialog semantics and no focus trap; both now go through the
// shared <Modal>. These assert the semantics Modal is supposed to bring, at the
// two real call sites, so a future refactor that drops the primitive fails here.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import type { TeamTemplate } from '@/features/teams/types'
import type { AgentIndexEntry, CatalogIndex } from '../catalogTypes'
import { CATALOG_SCHEMA_VERSION } from '../catalogTypes'
import { resetCatalogClient } from '../catalogClient'

import { AgentTemplateDetail } from '../AgentTemplateDetail'
import { TeamTemplateDetail } from '../TeamTemplateDetail'

afterEach(() => {
  cleanup()
  // The client memoizes by id, so a body fetched in one test must not leak
  // into the next.
  resetCatalogClient()
})

const AGENT: AgentIndexEntry = {
  id: 'clawboo-research-boo',
  packId: 'clawboo',
  name: 'Research Boo',
  role: 'Researcher',
  emoji: '🔎',
  color: '#3b82f6',
  description: 'Digs through sources and reports back.',
  source: 'clawboo',
  category: 'research',
  tags: ['research'],
  skillIds: [],
}

const TEAM: TeamTemplate = {
  id: 'clawboo-research-lab',
  packId: 'clawboo',
  name: 'Research Lab',
  emoji: '🧪',
  color: '#3b82f6',
  description: 'A small team that researches things.',
  category: 'research',
  source: 'clawboo',
  tags: ['research'],
  agentIds: [],
}

const CATALOG: CatalogIndex = {
  schemaVersion: CATALOG_SCHEMA_VERSION,
  counts: { agents: 1, teams: 1 },
  agents: [AGENT],
  teams: [{ ...TEAM, agentIds: [] }],
}

describe('AgentTemplateDetail', () => {
  it('is a modal dialog named after the agent', () => {
    render(
      <AgentTemplateDetail catalog={CATALOG} agent={AGENT} onClose={vi.fn()} onDeploy={vi.fn()} />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Research Boo' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <AgentTemplateDetail catalog={CATALOG} agent={AGENT} onClose={onClose} onDeploy={vi.fn()} />,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a scrim click but not on a panel click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(
      <AgentTemplateDetail catalog={CATALOG} agent={AGENT} onClose={onClose} onDeploy={vi.fn()} />,
    )
    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    const scrim = container.querySelector('[role="presentation"]') as HTMLElement
    await user.click(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <AgentTemplateDetail catalog={CATALOG} agent={AGENT} onClose={vi.fn()} onDeploy={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('TeamTemplateDetail', () => {
  it('is a modal dialog named after the team', () => {
    render(
      <TeamTemplateDetail catalog={CATALOG} template={TEAM} onClose={vi.fn()} onDeploy={vi.fn()} />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Research Lab' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <TeamTemplateDetail catalog={CATALOG} template={TEAM} onClose={onClose} onDeploy={vi.fn()} />,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <TeamTemplateDetail catalog={CATALOG} template={TEAM} onClose={vi.fn()} onDeploy={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
