// `clawboo agent-user plan --pool`: the commands for a user per agent.

import { describe, expect, it } from 'vitest'

import { agentPoolPlan, type PoolPlanInput } from '../plan'

const input: PoolPlanInput = {
  platform: 'linux',
  serverUser: 'clawboo',
  serverHome: '/home/clawboo',
  nodePath: '/usr/local/bin/node',
  users: 2,
  teams: 1,
  firstUid: 20001,
  firstTeamGid: 21001,
}

describe('agentPoolPlan', () => {
  it('makes each user with a group of its own, and the team groups', () => {
    const plan = agentPoolPlan(input)
    expect(plan).toContain('sudo groupadd -g 20001 clawboo-a1 && sudo useradd -u 20001 -g 20001')
    expect(plan).toContain('sudo groupadd -g 20002 clawboo-a2')
    expect(plan).toContain('sudo groupadd -g 21001 clawboo-t1')
    expect(plan).toContain('sudo usermod -aG clawboo-a1,clawboo-a2,clawboo-t1 clawboo')
  })

  it('writes the users inline in the one sudo rule', () => {
    expect(agentPoolPlan(input)).toContain(
      'clawboo ALL=(clawboo-a1, clawboo-a2 : clawboo-t1) NOPASSWD: ALL',
    )
    expect(agentPoolPlan(input)).not.toMatch(/Runas_Alias/)
  })

  it('ends with the settings to start with', () => {
    expect(agentPoolPlan(input)).toContain(
      'CLAWBOO_AGENT_USERS=clawboo-a1,clawboo-a2 CLAWBOO_AGENT_GROUPS=clawboo-t1 CLAWBOO_WORK_DIR=/var/lib/clawboo-work clawboo agent-user check',
    )
  })

  it('points macOS at one agent user', () => {
    expect(agentPoolPlan({ ...input, platform: 'darwin' })).toMatch(/runs on Linux for now/)
  })
})
