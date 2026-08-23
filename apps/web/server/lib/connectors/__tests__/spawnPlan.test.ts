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

  it('quotes a dangerous arg for DISPLAY without changing what is spawned', () => {
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn({ command: 'npx', args: ['& calc.exe'] })
    // Visible to the operator as a single quoted token...
    expect(plan.display).toContain('"& calc.exe"')
    // ...while argv is untouched.
    expect(plan.args).toEqual(['& calc.exe'])
  })
})
