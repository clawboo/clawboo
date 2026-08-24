// The tile must offer exactly what the server will accept. The shared
// `connectRefusal` predicate is what guarantees that, and these assert the two
// halves of it render differently.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** What `/config` reports. Mutable, so a test can put a connector in the state
 *  that follows a successful sign-in. */
const config = vi.hoisted(() => ({ authorized: false, satisfied: false }))

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
          credentials: [],
          authorized: config.authorized,
          argument: null,
          argumentSpec: {
            label: 'Folder this connector may read and write',
            description: 'Only this folder and everything inside it.',
            example: '/Users/you/projects/notes',
          },
          satisfied: config.satisfied,
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
  config.authorized = false
  config.satisfied = false
  useMarketplaceStore.setState({ connectorSearchQuery: '', connectorCategoryFilter: 'all' })
})

/** Open one connector's detail pane by name. */
async function openDetail(name: string) {
  render(<ConnectorsBrowser />)
  const card = await screen.findByRole('button', { name: new RegExp(`${name}.*Open details`, 'i') })
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
    useMarketplaceStore.setState({ connectorSearchQuery: 'Linear' })
    await openDetail('Linear')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^sign in$/i })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull()
    // Names what actually happens: a tab to somebody else's site.
    expect(screen.getByText(/opens linear in a new tab/i)).toBeTruthy()
  })

  it('offers CONNECT once a remote connector has been signed in', async () => {
    // The regression this exists for: the panel dropped the `authorized`
    // argument, so every remote connector read as never-signed-in and stayed on
    // "Not connectable yet" forever. Sign-in worked and led nowhere.
    config.authorized = true
    config.satisfied = true
    useMarketplaceStore.setState({ connectorSearchQuery: 'Linear' })
    await openDetail('Linear')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeTruthy()
    })
    expect(screen.queryByText(/not connectable yet/i)).toBeNull()
    // ...and the way back out is offered, which is the only thing that can
    // clear a token the provider has revoked.
    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeTruthy()
  })

  it('asks GitHub for a token rather than a sign-in it cannot perform', async () => {
    // GitHub publishes no dynamic registration endpoint and clawboo ships no
    // OAuth app, so a Sign in button there could only fail three requests in.
    // Its MCP server does take a personal access token, which turns the entry
    // from a dead end into a one-field connect.
    useMarketplaceStore.setState({ connectorSearchQuery: 'GitHub' })
    await openDetail('GitHub')
    await waitFor(() => {
      expect(screen.getByText(/Before it can run/i)).toBeTruthy()
    })
    // Twice on purpose: the field asks for it, and the copy-paste block
    // references it, which is what makes a remote entry with an input honest.
    expect(screen.getAllByText(/GITHUB_TOKEN/).length).toBeGreaterThan(0)
    // Neither of the two affordances that would lie about how this works.
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull()
    expect(screen.queryByText(/pre-registered OAuth app/i)).toBeNull()
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

  it('demotes the npx command and the config block behind a disclosure', async () => {
    // They were primary content when this tab was a directory and clawboo could
    // run nothing. For 18 of 19 entries they are now the fallback, and leaving
    // them on top is what made the pane read as documentation.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Knowledge Graph Memory' })
    await openDetail('Knowledge Graph Memory')
    await waitFor(() => expect(screen.getByText(/What it can do/i)).toBeTruthy())

    const disclosure = screen.getByText(/Technical details/i).closest('details')!
    // Collapsed, and the machinery is inside it rather than gone.
    expect(disclosure.hasAttribute('open')).toBe(false)
    expect(disclosure.textContent).toMatch(/server-memory/)
    expect(disclosure.textContent).toMatch(/Use it somewhere else/i)
    expect(disclosure.textContent).toMatch(/mcpServers/)
  })

  it('states what a connector can do, instead of scoring it', async () => {
    useMarketplaceStore.setState({ connectorSearchQuery: 'Knowledge Graph Memory' })
    await openDetail('Knowledge Graph Memory')
    await waitFor(() => expect(screen.getByText(/What it can do/i)).toBeTruthy())
    expect(screen.getByText(/Runs on this machine, as you/i)).toBeTruthy()
    expect(screen.getByText(/Cannot reach the network/i)).toBeTruthy()
    // The fraction is gone from every surface, not moved.
    expect(screen.queryByText(/\d\/3 risk/)).toBeNull()
  })

  it('names the missing thing in the refusal heading', async () => {
    // "Not connectable yet" is a category, and it read the same whether the
    // answer was one field away or impossible.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Notion' })
    await openDetail('Notion')
    await waitFor(() => expect(screen.getByText(/Before it can run/i)).toBeTruthy())
    expect(screen.queryByText(/Not connectable yet/i)).toBeNull()
  })

  it('offers a way to add a server the catalog does not list', async () => {
    // The catalog is a vouched starting set, not a ceiling. Without this the tab
    // silently implies 19 is all there is.
    render(<ConnectorsBrowser />)
    expect(await screen.findByRole('button', { name: /add your own mcp server/i })).toBeTruthy()
  })

  it('prices a zero-input connector rather than reporting a status', async () => {
    // The card used to read "Not connected" next to a Connect button, which is a
    // status the reader has to interpret and which framed a one-gesture entry as
    // a chore. It now names the COST and offers the verb.
    //
    // It still must not claim to be running when it is not, which is what this
    // test originally existed to pin.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Knowledge Graph Memory' })
    render(<ConnectorsBrowser />)
    const card = await screen.findByRole('button', {
      name: /Knowledge Graph Memory.*Open details/i,
    })
    expect(card.getAttribute('aria-label')).not.toMatch(/Active/i)
    expect(card.getAttribute('aria-label')).not.toMatch(/\bOn\b/)
    const tile = card.parentElement!
    expect(tile.textContent).toContain('Ready')
    expect(tile.textContent).toContain('Turn on')
    expect(tile.textContent).not.toContain('Not connected')
  })

  it('puts the action on the CARD, so nothing needs the detail view to start', async () => {
    // The whole point of the slice: every cost has its verb on the shelf.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Notion' })
    render(<ConnectorsBrowser />)
    const card = await screen.findByRole('button', { name: /Notion.*Open details/i })
    const tile = card.parentElement!
    expect(tile.textContent).toContain('Needs a key')
    expect(tile.textContent).toContain('Add key')
  })

  it('drops the risk fraction from the card', async () => {
    // `3/3 risk` counted trifecta legs, which describe what a connector can
    // REACH, not whether it is safe. A bare fraction beside a name reads as a
    // trustworthiness score and is not one, so it belongs in the detail pane
    // where the three legs can be named.
    useMarketplaceStore.setState({ connectorSearchQuery: 'Notion' })
    render(<ConnectorsBrowser />)
    const card = await screen.findByRole('button', { name: /Notion.*Open details/i })
    expect(card.parentElement!.textContent).not.toMatch(/\d\/3 risk/)
  })
})

describe('the two predicates never disagree', () => {
  // The one invariant this whole feature protects: a tile may not offer an
  // action the server refuses, and may not withhold one the server accepts.
  // Slice 3 broke the second half by asking the OAuth store about a connector
  // that authenticates with a pasted token, so GitHub was permanently stuck on
  // "Needs a key" while POST /api/connectors/connect would have returned 200.

  it('offers CONNECT for a bearer connector once its token is stored', async () => {
    config.authorized = true
    config.satisfied = true
    useMarketplaceStore.setState({ connectorSearchQuery: 'GitHub' })
    await openDetail('GitHub')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^connect$/i })).toBeTruthy()
    })
    // And it does not ask for a sign-in it cannot perform.
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull()
  })
})
