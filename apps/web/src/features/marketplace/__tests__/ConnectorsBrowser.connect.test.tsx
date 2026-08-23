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

  it('offers NO button for a remote connector, and says why', async () => {
    // Rendering Connect here would promise an OAuth flow that does not exist.
    useMarketplaceStore.setState({ connectorSearchQuery: 'GitHub' })
    await openDetail('GitHub')
    await waitFor(() => {
      expect(screen.getByText(/not connectable yet/i)).toBeTruthy()
    })
    expect(screen.getByText(/OAuth sign-in/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
  })

  it('explains the placeholder-path refusal for Filesystem', async () => {
    // Its committed args end in /path/to/allowed/dir and the server throws
    // without a real one, so Connect would fail at the handshake.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Filesystem' })
    await openDetail('Filesystem')
    await waitFor(() => {
      expect(screen.getByText(/path you have to fill in/i)).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
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
