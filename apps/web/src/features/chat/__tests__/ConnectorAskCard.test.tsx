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

import { cleanup, render, screen } from '@testing-library/react'
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
