import { describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', async (orig) => {
  const actual = await orig<typeof import('../../platform')>()
  return { ...actual, findExecutable: vi.fn(actual.findExecutable) }
})

import { findExecutable } from '../../platform'
import { planConnectorSpawn } from '../spawnPlan'

const mockFind = vi.mocked(findExecutable)

describe('planConnectorSpawn', () => {
  it('shows the RESOLVED absolute command, not the catalog spelling', () => {
    // "npx" and "/usr/local/bin/npx" are different consent requests.
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn({ command: 'npx', args: ['-y', 'pkg@1.0.0'] })
    expect(plan.command).toBe('/usr/local/bin/npx')
    expect(plan.display).toContain('/usr/local/bin/npx')
    expect(plan.unresolved).toBe(false)
  })

  it('reports an unresolved binary rather than throwing', () => {
    // A missing Node is an ordinary user-fixable condition, and the caller can
    // render it far better than an exception can.
    mockFind.mockReturnValueOnce(null)
    const plan = planConnectorSpawn({ command: 'npx', args: [] })
    expect(plan.unresolved).toBe(true)
    expect(plan.command).toBe('npx')
  })

  it('passes catalog args through as an ARRAY, never a shell string', () => {
    // The whole hazard: an arg from a registry snapshot containing shell
    // metacharacters must arrive at the child as literal argv.
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const nasty = ['-y', 'pkg@1.0.0', '& calc.exe', '$(whoami)', 'a|b']
    const plan = planConnectorSpawn({ command: 'npx', args: nasty })
    expect(plan.args).toEqual(nasty)
  })

  it('never rewrites the spawn command, so cross-spawn can do its own routing', () => {
    // The MCP SDK spawns through cross-spawn, which handles .cmd itself and sets
    // windowsVerbatimArguments -- the half that makes its escaping correct.
    // Pre-routing to cmd.exe here would make cross-spawn skip that, and Node
    // would re-quote an already-escaped line.
    mockFind.mockReturnValueOnce('C:\\Program Files\\nodejs\\npx.cmd')
    const plan = planConnectorSpawn({ command: 'npx', args: ['-y', 'pkg@1.0.0'] })
    expect(plan.command).toBe('C:\\Program Files\\nodejs\\npx.cmd')
    expect(plan.args).toEqual(['-y', 'pkg@1.0.0'])
    expect(plan.command.toLowerCase()).not.toContain('cmd.exe')
  })

  it('quotes a dangerous arg for DISPLAY without changing what is spawned', () => {
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn({ command: 'npx', args: ['& calc.exe'] })
    // Visible to the operator as a single quoted token...
    expect(plan.display).toContain('"& calc.exe"')
    // ...while argv is untouched.
    expect(plan.args).toEqual(['& calc.exe'])
  })
})
