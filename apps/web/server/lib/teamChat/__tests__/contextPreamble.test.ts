// buildServerTeamContext — the volatile team-context preamble. Asserts the
// runtime/role-gated coordination blocks + the leader-only [About the User] gating:
//   - a native LEADER turn gets the behavioral-guidance block + [About the User];
//   - ANY worker (delegated child) turn gets the worker guardrail and NOT [About the User];
//   - an OpenClaw agent gets the delegate-protocol block on any turn (+ the guardrail
//     when it's a worker turn).

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createDb, setSetting, teams, type ClawbooDb } from '@clawboo/db'

import { getDbPath } from '../../db'
import { buildServerTeamContext } from '../contextPreamble'

const NATIVE_LEADER_BLOCK = '[Leading this team'
const WORKER_BLOCK = '[Your task'
const OPENCLAW_BLOCK = '[How this team works'
const ABOUT_USER = '[About the User]'

describe('buildServerTeamContext coordination blocks', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-ctx-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = createDb(getDbPath())
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'Team T', icon: '🚀', color: '#e94560', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values([
        { id: 'nlead', name: 'Boo Zero', gatewayId: 'nlead', runtime: 'clawboo-native', teamId: 'T', createdAt: now, updatedAt: now },
        { id: 'nwork', name: 'Coder', gatewayId: 'nwork', runtime: 'clawboo-native', teamId: 'T', createdAt: now, updatedAt: now },
        { id: 'ocagent', name: 'OC One', gatewayId: 'ocagent', sourceId: 'openclaw', runtime: 'openclaw', teamId: 'T', createdAt: now, updatedAt: now },
        { id: 'hlead', name: 'Hermes One', gatewayId: 'hlead', runtime: 'hermes', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    // The user's onboarding self-intro (so the [About the User] gating is observable).
    setSetting(db, 'team-onboarding:T', JSON.stringify({ userIntroText: 'I am a PM building a support tool' }))
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('LEADER turn: native leader block + [About the User], no worker guardrail', () => {
    const ctx = buildServerTeamContext(db, 'T', 'nlead', true) ?? ''
    expect(ctx).toContain(NATIVE_LEADER_BLOCK)
    expect(ctx).toContain('Answer simple questions')
    expect(ctx).toContain(ABOUT_USER)
    expect(ctx).toContain('I am a PM')
    expect(ctx).not.toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(OPENCLAW_BLOCK)
  })

  it('native WORKER turn: worker guardrail, NO [About the User], NO leader block', () => {
    const ctx = buildServerTeamContext(db, 'T', 'nwork', false) ?? ''
    expect(ctx).toContain(WORKER_BLOCK)
    expect(ctx).toContain('You CANNOT reach the user')
    expect(ctx).not.toContain(ABOUT_USER) // the user intro is leader-only
    expect(ctx).not.toContain(NATIVE_LEADER_BLOCK)
    // the roster is still present (the worker still sees teammate names)
    expect(ctx).toContain('Boo Zero')
  })

  it('OpenClaw LEADER turn: delegate-protocol block + [About the User], no worker guardrail', () => {
    const ctx = buildServerTeamContext(db, 'T', 'ocagent', true) ?? ''
    expect(ctx).toContain(OPENCLAW_BLOCK)
    expect(ctx).toContain(ABOUT_USER)
    expect(ctx).not.toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(NATIVE_LEADER_BLOCK)
  })

  it('OpenClaw WORKER turn: delegate-protocol block + worker guardrail, NO [About the User]', () => {
    const ctx = buildServerTeamContext(db, 'T', 'ocagent', false) ?? ''
    expect(ctx).toContain(OPENCLAW_BLOCK) // anti-spawn preserved for a worker
    expect(ctx).toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(ABOUT_USER)
  })

  it('non-native / non-openclaw worker (hermes) still gets the worker guardrail', () => {
    const worker = buildServerTeamContext(db, 'T', 'hlead', false) ?? ''
    expect(worker).toContain(WORKER_BLOCK)
    expect(worker).not.toContain(NATIVE_LEADER_BLOCK)
    expect(worker).not.toContain(OPENCLAW_BLOCK)
    // as a leader turn it gets neither runtime block nor the worker guardrail
    const leader = buildServerTeamContext(db, 'T', 'hlead', true) ?? ''
    expect(leader).not.toContain(WORKER_BLOCK)
    expect(leader).not.toContain(NATIVE_LEADER_BLOCK)
  })
})
