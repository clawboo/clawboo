// Reading the target app off a broker call's arguments.
//
// The properties that matter are the two failure directions: a shape this does
// not understand must never read as "nothing to check", and the two meta-tools
// that can reach anything must never be mistaken for app-scoped ones.

import { describe, expect, it } from 'vitest'

import {
  brokeredAppConnectorId,
  brokeredAppScope,
  isBrokeredReadOnlyMetaTool,
} from '../brokeredApp'

const KNOWN = ['gmail', 'googlesheets', 'slack', 'github', 'githubactions', 'microsoft_teams']

const scope = (tool: string, args: Record<string, unknown>) => brokeredAppScope(tool, args, KNOWN)

describe('brokeredAppScope', () => {
  it('reads the app off an executing call', () => {
    expect(
      scope('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }],
      }),
    ).toEqual({ kind: 'apps', toolkits: ['gmail'], executing: true })
  })

  it('reads every app in a batch, so one grant cannot carry another app along', () => {
    const out = scope('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [
        { tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} },
        { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE', arguments: {} },
      ],
    })
    expect(out.kind).toBe('apps')
    expect(out.kind === 'apps' && [...out.toolkits].sort()).toEqual(['gmail', 'googlesheets'])
  })

  it('matches the LONGEST toolkit, not the first underscore', () => {
    // `microsoft_teams` would resolve to `microsoft` on a first-underscore split,
    // which is not a toolkit, and an ordinary call would fail closed.
    expect(
      scope('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug: 'MICROSOFT_TEAMS_SEND_MESSAGE', arguments: {} }],
      }),
    ).toEqual({ kind: 'apps', toolkits: ['microsoft_teams'], executing: true })

    // ...and a prefix must end at a boundary, or `github` would claim these.
    expect(
      scope('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug: 'GITHUBACTIONS_RUN_WORKFLOW', arguments: {} }],
      }),
    ).toEqual({ kind: 'apps', toolkits: ['githubactions'], executing: true })
  })

  it('reads the toolkits array that connection management uses', () => {
    expect(
      scope('mcp__composio__COMPOSIO_MANAGE_CONNECTIONS', {
        toolkits: [{ name: 'slack', action: 'add' }],
      }),
    ).toEqual({ kind: 'apps', toolkits: ['slack'], executing: false })
  })

  it('names the remote sandbox and shell as unscoped, never as app-scoped', () => {
    // Composio preloads `run_composio_tool` into the workbench, so an agent
    // holding it reaches any app from inside code no argument reader can see.
    for (const tool of ['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_REMOTE_BASH_TOOL']) {
      expect(
        scope(`mcp__composio__${tool}`, { code: 'run_composio_tool("GMAIL_SEND_EMAIL")' }),
      ).toEqual({ kind: 'unscoped', tool })
    }
  })

  it('fails closed on an executing call it cannot read', () => {
    // A slug for a toolkit nobody has heard of, and a shape with no slug at all.
    expect(
      scope('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: [{ tool_slug: 'NOTATOOLKIT_DO_THING', arguments: {} }],
      }).kind,
    ).toBe('unknown')
    expect(scope('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL', { thought: 'hi' }).kind).toBe(
      'unknown',
    )
  })

  it('lets an unnamed discovery call through: it searches, it does not execute', () => {
    expect(scope('mcp__composio__COMPOSIO_SEARCH_TOOLS', { queries: [{ use_case: 'x' }] })).toEqual(
      { kind: 'not-brokered' },
    )
  })

  it('ignores a tool that is not a broker meta-tool at all', () => {
    expect(scope('mcp__filesystem__read_file', { path: '/tmp/x' })).toEqual({
      kind: 'not-brokered',
    })
  })
})

describe('brokeredAppConnectorId', () => {
  it('extends the session identity rather than inventing a second one', () => {
    expect(brokeredAppConnectorId('conn:connector:clawboo-native:mcp:composio', 'gmail')).toBe(
      'conn:connector:clawboo-native:mcp:composio:app:gmail',
    )
  })
})

describe('isBrokeredReadOnlyMetaTool', () => {
  it('treats catalogue search and schema reads as read-only', () => {
    // These execute nothing. Prompting for them made an agent wait two minutes
    // for an approval nobody was looking at, then report the timeout to the
    // operator as a Composio outage.
    expect(isBrokeredReadOnlyMetaTool('mcp__composio__COMPOSIO_SEARCH_TOOLS')).toBe(true)
    expect(isBrokeredReadOnlyMetaTool('mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS')).toBe(true)
  })

  it('still asks about anything that acts', () => {
    // MANAGE_CONNECTIONS with action:add mints an authorisation link, and
    // MULTI_EXECUTE runs the upstream tool. Both are side effects.
    expect(isBrokeredReadOnlyMetaTool('mcp__composio__COMPOSIO_MANAGE_CONNECTIONS')).toBe(false)
    expect(isBrokeredReadOnlyMetaTool('mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL')).toBe(false)
    expect(isBrokeredReadOnlyMetaTool('mcp__composio__COMPOSIO_REMOTE_BASH_TOOL')).toBe(false)
    expect(isBrokeredReadOnlyMetaTool('mcp__filesystem__read_file')).toBe(false)
  })
})
