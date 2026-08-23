// The tile must offer exactly what the server will accept. The shared
// `connectRefusal` predicate is what guarantees that, and these assert the two
// halves of it render differently.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clawboo/control-client', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/api/connectors') {
      return { ok: true, json: async () => ({ ok: true, connectors: [] }) } as Response
    }
    if (path === '/api/connectors/custom') {
      return { ok: true, json: async () => ({ ok: true, connectors: [] }) } as Response
    }
    if (path.endsWith('/config')) {
      // Nothing supplied yet, which is the state the form exists for.
      return {
        ok: true,
        json: async () => ({
          ok: true,
          credentials: [],
          authorized: false,
          argument: null,
          argumentSpec: {
            label: 'Folder this connector may read and write',
            description: 'Only this folder and everything inside it.',
            example: '/Users/you/projects/notes',
          },
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

/** Open one connector's detail pane by name. */
async function openDetail(name: string) {
  render(<ConnectorsBrowser />)
  const card = await screen.findByRole('button', { name: new RegExp(name, 'i') })
  // fireEvent, not a raw .click(): the raw call is outside act(), so the state
  // update it triggers races the assertion.
  fireEvent.click(card)
}

describe('ConnectorsBrowser connect affordance', () => {
  it('offers Connect for a connector the server can actually run', async () => {
    useMarketplaceStore.setState({ connectorSearchQuery: 'Knowledge Graph Memory' })
    await openDetail('Knowledge Graph Memory')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeTruthy()
    })
  })

  it('offers SIGN IN for a remote connector, not Connect', async () => {
    // Connect would promise a session the provider has not authorized. Sign in
    // is the step that actually exists, so that is what the tile offers.
    useMarketplaceStore.setState({ connectorSearchQuery: 'GitHub' })
    await openDetail('GitHub')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
    // Names what actually happens: a tab to somebody else's site.
    expect(screen.getByText(/opens github in a new tab/i)).toBeTruthy()
  })

  it('ASKS for the folder Filesystem needs, instead of refusing outright', async () => {
    // Its committed args end in /path/to/allowed/dir and the server throws
    // without a real one. That is a question to ask, not a wall: the tile now
    // renders the field rather than an explanation of why it cannot be used.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Filesystem' })
    await openDetail('Filesystem')
    await waitFor(() => {
      expect(screen.getByText(/Folder this connector may read and write/i)).toBeTruthy()
    })
    // No Connect until the folder is supplied, because the server would refuse.
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
    expect(screen.getByPlaceholderText('/Users/you/projects/notes')).toBeTruthy()
  })

  it('asks for a credential rather than declaring the connector unusable', async () => {
    useMarketplaceStore.setState({ connectorSearchQuery: 'Notion' })
    await openDetail('Notion')
    await waitFor(() => {
      expect(screen.getByText(/Before it can run/i)).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
  })

  it('offers a way to add a server the catalog does not list', async () => {
    // The catalog is a vouched starting set, not a ceiling. Without this the tab
    // silently implies 19 is all there is.
    render(<ConnectorsBrowser />)
    expect(await screen.findByRole('button', { name: /add your own mcp server/i })).toBeTruthy()
  })

  it('does not claim "Active" on a tile that offers Connect', async () => {
    // The two together asserted a state the backend did not have.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Knowledge Graph Memory' })
    render(<ConnectorsBrowser />)
    const card = await screen.findByRole('button', { name: /Knowledge Graph Memory/i })
    expect(card.getAttribute('aria-label')).not.toMatch(/Active/i)
    expect(card.textContent).toContain('Not connected')
  })
})
