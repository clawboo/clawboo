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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectorAskBody } from '@clawboo/connector-catalog'

import { MetaMessageCard } from '../chatComponents'
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
})

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
    expect(useMarketplaceStore.getState().marketplaceTab).toBe('connectors')
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'marketplace' })
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

  function stubConnectorApis(opts: { live?: string[]; configured?: string[] }): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/connectors/configured')) {
        return Promise.resolve(
          new Response(JSON.stringify({ slugs: opts.configured ?? [] }), { status: 200 }),
        )
      }
      if (url.includes('/api/connectors')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ connectors: (opts.live ?? []).map((slug) => ({ slug, tools: [] })) }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
  }

  it('says a connector is connected instead of offering to connect it again', async () => {
    stubConnectorApis({ live: ['linear'] })
    render(<MetaMessageCard entry={metaEntry(connectorAskBody(['linear']))} />)

    await waitFor(() => {
      expect(screen.getByText(/Linear connected/)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /Connect Linear/ })).toBeNull()
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
      if (url.includes('/api/connectors/configured')) {
        return Promise.resolve(new Response(JSON.stringify({ slugs: [] }), { status: 200 }))
      }
      if (url.includes('/api/connectors')) {
        return Promise.resolve(
          new Response(JSON.stringify({ connectors: [{ slug: 'linear', tools: [] }] }), {
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
