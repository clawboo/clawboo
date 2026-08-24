import { describe, expect, it } from 'vitest'

import { connectorBySlug } from '../index'
import { launchArgsSatisfied, resolveLaunchArgs } from '../launchArgs'

describe('resolveLaunchArgs', () => {
  it('SUBSTITUTES the placeholder for filesystem', () => {
    const fs = connectorBySlug('filesystem')!
    const args = resolveLaunchArgs(fs, '/Users/me/notes')
    expect(args).toContain('/Users/me/notes')
    expect(args).not.toContain('/path/to/allowed/dir')
  })

  it('APPENDS for sqlite, which carries no placeholder', () => {
    // Two entries, two shapes, one function: expressing this as two code paths
    // would be two chances to get argv wrong.
    const sqlite = connectorBySlug('sqlite')!
    const args = resolveLaunchArgs(sqlite, '/Users/me/app.db')
    expect(args[args.length - 1]).toBe('/Users/me/app.db')
    expect(args).toContain('mcp-server-sqlite-npx@0.8.0')
  })

  it('leaves an entry with no user argument completely untouched', () => {
    const memory = connectorBySlug('memory')!
    expect(resolveLaunchArgs(memory, 'ignored')).toEqual(
      memory.launch.transport === 'stdio' ? memory.launch.args : [],
    )
  })

  it('returns the catalog args when no value is supplied', () => {
    const fs = connectorBySlug('filesystem')!
    expect(resolveLaunchArgs(fs)).toContain('/path/to/allowed/dir')
  })

  it('treats whitespace as unsatisfied', () => {
    const fs = connectorBySlug('filesystem')!
    expect(launchArgsSatisfied(fs, '   ')).toBe(false)
    expect(launchArgsSatisfied(fs, '/tmp')).toBe(true)
    // An entry that needs nothing is always satisfied.
    expect(launchArgsSatisfied(connectorBySlug('memory')!)).toBe(true)
  })
})
