// One node per app the agent can actually reach.
//
// A broker is a single MCP session carrying many upstream apps. Reporting only
// the session hides what it reaches: a reader looking at a node marked
// "Composio" has no way to know their agent can read email. These check that
// each connected app becomes its own record, that it is distinguishable from
// the broker, and that an unknown cache stays silent rather than guessing.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const liveConnectors = vi.fn()
vi.mock('../../connectors/supervisor', () => ({
  listLiveConnectors: () => liveConnectors(),
}))

const connectedNow = vi.fn()
vi.mock('../../connectors/composio', () => ({
  connectedAppsNow: () => connectedNow(),
}))

import { ConnectorCapabilitySource } from '../connector'

const composioSession = {
  connectorId: 'conn:connector:clawboo-native:mcp:composio',
  slug: 'composio',
  descriptors: [{ name: 'a' }, { name: 'b' }],
  skipped: [],
}

describe('brokered apps as their own capability records', () => {
  beforeEach(() => {
    liveConnectors.mockReset()
    connectedNow.mockReset()
    liveConnectors.mockReturnValue([composioSession])
    connectedNow.mockReturnValue({ connected: new Set<string>(), known: false })
  })

  it('emits a record for each connected app, beside the broker', async () => {
    connectedNow.mockReturnValue({
      connected: new Set(['gmail', 'slack']),
      known: true,
    })
    const { records } = await new ConnectorCapabilitySource().read()
    const names = records.map((r) => r.name).sort()
    expect(names).toContain('Gmail')
    expect(names).toContain('Slack')
    // The broker is still there. The apps are additional, not a replacement:
    // the session is a real thing an operator can disconnect.
    expect(names).toContain('Composio')
  })

  it('gives each app its own key, so they do not collapse onto one node', async () => {
    connectedNow.mockReturnValue({ connected: new Set(['gmail', 'jira']), known: true })
    const { records } = await new ConnectorCapabilitySource().read()
    const keys = records.map((r) => r.sourceKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('mcp:composio:app:gmail')
    expect(keys).toContain('mcp:composio:app:jira')
  })

  it('says nothing when the broker has not been asked yet', async () => {
    // An unknown cache must not be rendered as "no apps", and must never block
    // a graph rebuild on a network call to find out.
    const { records } = await new ConnectorCapabilitySource().read()
    expect(records).toHaveLength(1)
    expect(records[0]?.name).toBe('Composio')
  })

  it('ignores a toolkit the catalog does not know', async () => {
    connectedNow.mockReturnValue({
      connected: new Set(['gmail', 'not-a-real-toolkit']),
      known: true,
    })
    const { records } = await new ConnectorCapabilitySource().read()
    expect(records.map((r) => r.name)).not.toContain('not-a-real-toolkit')
    expect(records.map((r) => r.name)).toContain('Gmail')
  })

  it('emits no app records when the broker itself is not connected', async () => {
    liveConnectors.mockReturnValue([])
    connectedNow.mockReturnValue({ connected: new Set(['gmail']), known: true })
    const { records } = await new ConnectorCapabilitySource().read()
    expect(records).toHaveLength(0)
  })
})
