// The two marketplace detail sheets. They were near-byte-identical hand-rolled
// overlays with no dialog semantics and no focus trap; both now go through the
// shared <Modal>. These assert the semantics Modal is supposed to bring, at the
// two real call sites, so a future refactor that drops the primitive fails here.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'
import type { AgentCatalogEntry, TeamTemplate } from '@/features/teams/types'

import { AgentTemplateDetail } from '../AgentTemplateDetail'
import { TeamTemplateDetail } from '../TeamTemplateDetail'

afterEach(() => cleanup())

const AGENT: AgentCatalogEntry = {
  id: 'clawboo-research-boo',
  name: 'Research Boo',
  role: 'Researcher',
  emoji: '🔎',
  color: '#3b82f6',
  description: 'Digs through sources and reports back.',
  source: 'clawboo',
  sourceUrl: 'https://github.com/clawboo/clawboo',
  domain: 'clawboo',
  category: 'research',
  tags: ['research'],
  skillIds: [],
  soulTemplate: '# SOUL',
  identityTemplate: '# IDENTITY\n\nResearches things.',
  toolsTemplate: '# TOOLS',
}

const TEAM: TeamTemplate = {
  id: 'clawboo-research-lab',
  name: 'Research Lab',
  emoji: '🧪',
  color: '#3b82f6',
  description: 'A small team that researches things.',
  category: 'research',
  source: 'clawboo',
  tags: ['research'],
  agentIds: [],
}

describe('AgentTemplateDetail', () => {
  it('is a modal dialog named after the agent', () => {
    render(<AgentTemplateDetail agent={AGENT} onClose={vi.fn()} onDeploy={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Research Boo' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AgentTemplateDetail agent={AGENT} onClose={onClose} onDeploy={vi.fn()} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a scrim click but not on a panel click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(
      <AgentTemplateDetail agent={AGENT} onClose={onClose} onDeploy={vi.fn()} />,
    )
    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    const scrim = container.querySelector('[role="presentation"]') as HTMLElement
    await user.click(scrim)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <AgentTemplateDetail agent={AGENT} onClose={vi.fn()} onDeploy={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('TeamTemplateDetail', () => {
  it('is a modal dialog named after the team', () => {
    render(<TeamTemplateDetail template={TEAM} onClose={vi.fn()} onDeploy={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Research Lab' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TeamTemplateDetail template={TEAM} onClose={onClose} onDeploy={vi.fn()} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = render(
      <TeamTemplateDetail template={TEAM} onClose={vi.fn()} onDeploy={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
