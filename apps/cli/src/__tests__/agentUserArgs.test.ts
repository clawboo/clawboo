import { describe, expect, it } from 'vitest'

import { agentUserArgs } from '../agentUserArgs'

describe('agentUserArgs', () => {
  it('forwards the one-user plan as before', () => {
    expect(agentUserArgs({ user: 'clawboo-agent' })).toEqual(['--user', 'clawboo-agent'])
    expect(agentUserArgs({})).toEqual([])
  })

  it('forwards every pool flag', () => {
    expect(
      agentUserArgs({ pool: '8', teams: '4', firstUid: '20001', firstTeamGid: '21001' }),
    ).toEqual(['--pool', '8', '--teams', '4', '--first-uid', '20001', '--first-team-gid', '21001'])
  })
})
