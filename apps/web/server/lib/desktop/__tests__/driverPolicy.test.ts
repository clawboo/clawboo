// A desktop driver types into the agent's browser, so it runs only where that
// browser runs as the agent's own OS user.

import { describe, expect, it } from 'vitest'

import { desktopDriverRefusal } from '../driverPolicy'

describe('desktopDriverRefusal', () => {
  it('refuses without agents on their own OS user, and says why', () => {
    expect(desktopDriverRefusal('Cua Driver', false)).toMatch(
      /Cua Driver needs agents to run as their own OS user \(CLAWBOO_AGENT_USER\)/,
    )
    expect(desktopDriverRefusal('Cua Driver', true)).toBeNull()
  })

  it('reads the setting from the environment by default', () => {
    const prev = process.env['CLAWBOO_AGENT_USER']
    delete process.env['CLAWBOO_AGENT_USER']
    try {
      expect(desktopDriverRefusal('Cua Driver')).not.toBeNull()
    } finally {
      if (prev !== undefined) process.env['CLAWBOO_AGENT_USER'] = prev
    }
  })
})
