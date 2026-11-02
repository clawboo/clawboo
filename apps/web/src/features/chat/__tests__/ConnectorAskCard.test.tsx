// ConnectorAskCard — the offer, rendered where the agent made it.
//
// This is the one surface that reaches somebody who never opens the marketplace,
// so the two things locked here are the two that make it worth shipping: the
// button is PRICED (a connector needing a key must not say "Connect", which would
// promise a one-click that then asks for a token), and it ROUTES all the way to
// that connector's own pane rather than dumping the reader on a tab to search.
//
// The prose is asserted to come from the stored line, not rebuilt from the slugs.
// Rebuilding it is exactly what produced "Linear and Notion and Figma" on screen
// while the stored sentence read correctly.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectorAskBody } from '@clawboo/connector-catalog'

import { server } from '@/__vitest__/mswServer'
import { MetaMessageCard } from '../chatComponents'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import { useMarketplaceStore } from '@/stores/marketplace'
import { useViewStore } from '@/stores/view'

function metaEntry(text: string) {
  return {
    entryId: 'e1',
    role: 'system' as const,
    kind: 'meta' as const,
    text,
    sessionKey: 'agent:a:team:t',
    runId: null,
    source: 'local-send' as const,
    timestampMs: 0,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
  }
}

afterEach(cleanup)
beforeEach(() => {
  useMarketplaceStore.getState().setOpenConnectorSlug(null)
  useViewStore.getState().navigateTo('graph')
  // The agent that asked: `agent:a:team:t` above.
  useFleetStore.setState({ agents: [{ id: 'a', name: 'Scout', teamId: 't' } as AgentState] })
  // Nothing live, nothing configured, nothing shared, unless a test says so.
  server.use(
    http.get('/api/connectors', () => HttpResponse.json({ connectors: [] })),
    http.get('/api/connectors/configured', () => HttpResponse.json({ slugs: [] })),
    http.get('/api/grants', () => HttpResponse.json({ grants: [] })),
  )
})

/** A live row the way GET /api/connectors sends it, with the id grants key on. */
const liveRow = (slug: string) => ({ slug, connectorId: `conn:${slug}`, tools: [] })

/** GET /api/grants answering with grants on these connector slugs. */
const grantsFor = (slugs: string[]) =>
  new Response(
    JSON.stringify({ grants: slugs.map((s) => ({ connectorId: `conn:${s}`, revokedAt: null })) }),
    { status: 200 },
  )

describe('ConnectorAskCard', () => {
  it('renders the stored sentence rather than rebuilding one from the slugs', () => {
    const body = connectorAskBody(['linear', 'notion', 'figma'])
    render(<MetaMessageCard entry={metaEntry(body)} />)
    expect(screen.getByText(/Linear, Notion, and Figma would each let/)).toBeInTheDocument()
  })

  it('prices each button by what that connector actually costs', () => {
    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['linear', 'notion']))} />)
    // Linear signs in; Notion wants a key. One card, two different promises.
    expect(screen.getByRole('button', { name: /Connect Linear/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add key Notion/ })).toBeInTheDocument()
  })

  it('routes to that connector’s own pane, not merely to the marketplace', async () => {
    const user = userEvent.setup()
    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['notion']))} />)
    await user.click(screen.getByRole('button', { name: /Add key Notion/ }))

    expect(useMarketplaceStore.getState().openConnectorSlug).toBe('notion')
    // THE ASKING AGENT TRAVELS WITH IT, so the connector page can give it access
    // once Notion is connected. Connecting from here used to grant nobody.
    expect(useMarketplaceStore.getState().connectorAskFor).toEqual({
      agentId: 'a',
      agentName: 'Scout',
    })
    // ITS OWN DESTINATION now, not a tab inside the Marketplace. The slug is
    // what makes this a deep link rather than a signpost: the reader lands on
    // Notion's own pane, not on a list to search again.
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'connectors' })
  })

  it('leaves an ordinary meta line alone', () => {
    render(<MetaMessageCard entry={metaEntry('[Task Update] shipped')} />)
    expect(screen.getByText('[Task Update] shipped')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing special when every slug is unknown', () => {
    render(<MetaMessageCard entry={metaEntry('clawboo:connect-ask nope,alsonope some words')} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ConnectorAskCard reflects live state', () => {
  // The defect: the card priced from the bare definition, so it went on saying
  // "Connect Linear" after the reader had connected Linear from this very card,
  // and offered "Add key Notion" to somebody whose key was already stored.
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function stubConnectorApis(opts: {
    live?: string[]
    configured?: string[]
    shared?: string[]
  }): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/grants')) return Promise.resolve(grantsFor(opts.shared ?? []))
      if (url.includes('/api/connectors/configured')) {
        return Promise.resolve(
          new Response(JSON.stringify({ slugs: opts.configured ?? [] }), { status: 200 }),
        )
      }
      if (url.includes('/api/connectors')) {
        return Promise.resolve(
          new Response(JSON.stringify({ connectors: (opts.live ?? []).map(liveRow) }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
  }

  it('says a connector is connected instead of offering to connect it again', async () => {
    stubConnectorApis({ live: ['linear'], shared: ['linear'] })
    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['linear']))} />)

    await waitFor(() => {
      expect(screen.getByText(/Linear connected/)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Connect Linear/ })).toBeNull()
  })

  it('offers to share a live connector the asking agent has no access to', async () => {
    // Connected is not usable: an agent with no grant gets no tools, which is
    // often exactly why it asked. The card used to read "Linear connected" here
    // and offer Continue, which woke an agent that still could not reach it.
    stubConnectorApis({ live: ['linear'], shared: [] })
    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['linear']))} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Share Linear with Scout' })).toBeInTheDocument()
    })
    expect(screen.queryByText(/Linear connected/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('prices a connector whose key is already stored as ready, not as needing a key', async () => {
    stubConnectorApis({ configured: ['notion'] })
    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['notion']))} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Turn on Notion/ })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Add key Notion/ })).toBeNull()
  })
})

describe('ConnectorAskCard closes the loop after connecting', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('offers Continue once every asked-for connector is live', async () => {
    // The gap this fills: the agent stopped, the reader connected the thing,
    // and then nothing happened. They had to come back and retype the request.
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/grants')) return Promise.resolve(grantsFor(['linear']))
      if (url.includes('/api/connectors/configured')) {
        return Promise.resolve(new Response(JSON.stringify({ slugs: [] }), { status: 200 }))
      }
      if (url.includes('/api/connectors')) {
        return Promise.resolve(
          new Response(JSON.stringify({ connectors: [liveRow('linear')] }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch

    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['linear']))} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    })
  })

  it('offers no Continue while a connector is still missing', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ connectors: [], slugs: [] }), { status: 200 }),
      )) as typeof fetch

    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['linear', 'notion']))} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Connect Linear/ })).toBeInTheDocument()
    })
    // Resuming with half of what was asked for would restart a turn that stops
    // again for the same reason.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
