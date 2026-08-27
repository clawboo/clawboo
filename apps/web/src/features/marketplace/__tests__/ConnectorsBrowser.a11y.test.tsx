// The connectors surface is the newest set of controls in the app and the only
// one that spawns a process, so its semantics are worth pinning: a screen reader
// user deciding whether to start a local server needs the same information a
// sighted one gets.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__vitest__/axe'

vi.mock('@clawboo/control-client', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/connectors') {
      return { ok: true, json: async () => ({ ok: true, connectors: [] }) } as Response
    }
    if (path === '/api/connectors/custom') {
      return { ok: true, json: async () => ({ ok: true, connectors: [] }) } as Response
    }
    if (path.endsWith('/config')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          credentials: [
            {
              key: 'NOTION_TOKEN',
              description: 'A Notion integration token.',
              required: true,
              secret: true,
              present: false,
            },
          ],
          authorized: false,
          argument: null,
          argumentSpec: null,
          satisfied: false,
        }),
      } as Response
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response
  }),
}))

import { ConnectorsBrowser } from '../ConnectorsBrowser'
import { useMarketplaceStore } from '@/stores/marketplace'

afterEach(() => {
  cleanup()
  useMarketplaceStore.setState({ connectorSearchQuery: '', connectorCategoryFilter: 'all' })
})

describe('ConnectorsBrowser accessibility', () => {
  it('the directory grid has no axe violations', async () => {
    const { container } = render(<ConnectorsBrowser />)
    await screen.findByRole('button', { name: /Knowledge Graph Memory.*Open details/i })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('a connector card names its PRICE in its accessible name', async () => {
    // The pill is decoration to a screen reader; the card's own label is what
    // gets announced, so the cost has to live there. It used to announce a risk
    // fraction, which told a screen-reader user a number with no unit and never
    // told them what the entry would cost them.
    render(<ConnectorsBrowser />)
    const card = await screen.findByRole('button', {
      name: /Knowledge Graph Memory.*Open details/i,
    })
    const label = card.getAttribute('aria-label') ?? ''
    expect(label).toMatch(/Ready/)
    expect(label).toMatch(/open details/i)
    expect(label).not.toMatch(/risk signals/i)
  })

  it('the card action is its own control, not nested inside the open button', async () => {
    // A button inside a button is invalid and the inner one never fires, which
    // is exactly how the Chip regression happened earlier in this feature.
    render(<ConnectorsBrowser />)
    const open = await screen.findByRole('button', {
      name: /Knowledge Graph Memory.*Open details/i,
    })
    const action = within(open.parentElement!).getByRole('button', {
      name: /^connect knowledge graph memory$/i,
    })
    expect(open.contains(action)).toBe(false)
  })

  it('the detail pane has no axe violations', async () => {
    useMarketplaceStore.setState({ connectorSearchQuery: 'Knowledge Graph Memory' })
    const { container } = render(<ConnectorsBrowser />)
    fireEvent.click(
      await screen.findByRole('button', { name: /Knowledge Graph Memory.*Open details/i }),
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /^connect$/i })).toBeTruthy())
    expect(await axe(container)).toHaveNoViolations()
  })

  it('the credential form labels every field it asks for', async () => {
    // An input a screen reader announces as "edit text, blank" is not a question
    // anyone can answer, least of all one about a secret.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Notion' })
    const { container } = render(<ConnectorsBrowser />)
    fireEvent.click(await screen.findByRole('button', { name: /Notion.*Open details/i }))
    await waitFor(() => expect(screen.getByText(/Before it can run/i)).toBeTruthy())

    const field = container.querySelector('input[type="password"]')
    expect(field).not.toBeNull()
    // Wrapped in its own <label>, so the key name and description are the
    // accessible name rather than nearby text that happens to look related.
    expect(field!.closest('label')).not.toBeNull()
    expect(await axe(container)).toHaveNoViolations()
  })
})
