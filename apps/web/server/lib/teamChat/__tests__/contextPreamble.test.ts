// buildServerTeamContext — the volatile team-context preamble. Asserts the
// runtime/role-gated coordination blocks + the leader-only [About the User] gating:
//   - a native LEADER turn gets the behavioral-guidance block + [About the User];
//   - a CODING-runtime (codex/claude-code/hermes) LEADER turn gets the
//     `team_delegate` leader block — its ONLY instruction channel (persona-inert);
//   - ANY worker (delegated child) turn gets the worker guardrail and NOT [About the User];
//   - an OpenClaw agent gets the delegate-protocol block on any turn (+ the guardrail
//     when it's a worker turn).
// The native and coding leader blocks share the '[Leading this team' framing; they
// are distinguished by WHICH delegation tool they teach (`delegate` vs `team_delegate`).

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createDb, setSetting, teams, type ClawbooDb } from '@clawboo/db'

import { getDbPath } from '../../db'
import { buildServerTeamContext } from '../contextPreamble'

const LEADER_BLOCK = '[Leading this team' // shared framing (native AND coding leaders)
const CODING_LEADER_TOOL = 'team_delegate' // the coding leader block's tool (MCP)
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
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        {
          id: 'nlead',
          name: 'Boo Zero',
          gatewayId: 'nlead',
          runtime: 'clawboo-native',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'nwork',
          name: 'Coder',
          gatewayId: 'nwork',
          runtime: 'clawboo-native',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'ocagent',
          name: 'OC One',
          gatewayId: 'ocagent',
          sourceId: 'openclaw',
          runtime: 'openclaw',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'hlead',
          name: 'Hermes One',
          gatewayId: 'hlead',
          runtime: 'hermes',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
    // The user's onboarding self-intro (so the [About the User] gating is observable).
    setSetting(
      db,
      'team-onboarding:T',
      JSON.stringify({ userIntroText: 'I am a PM building a support tool' }),
    )
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('LEADER turn: native leader block + [About the User], no worker guardrail', () => {
    const ctx = buildServerTeamContext(db, 'T', 'nlead', true) ?? ''
    expect(ctx).toContain(LEADER_BLOCK)
    expect(ctx).toContain('Answer simple questions')
    expect(ctx).toContain(ABOUT_USER)
    expect(ctx).toContain('I am a PM')
    // The NATIVE leader delegates via its LOCAL `delegate` tool, never the MCP one.
    expect(ctx).not.toContain(CODING_LEADER_TOOL)
    expect(ctx).not.toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(OPENCLAW_BLOCK)
  })

  it('native WORKER turn: worker guardrail, NO [About the User], NO leader block', () => {
    const ctx = buildServerTeamContext(db, 'T', 'nwork', false) ?? ''
    expect(ctx).toContain(WORKER_BLOCK)
    expect(ctx).toContain('You CANNOT reach the user')
    expect(ctx).not.toContain(ABOUT_USER) // the user intro is leader-only
    expect(ctx).not.toContain(LEADER_BLOCK)
    // the roster is still present (the worker still sees teammate names)
    expect(ctx).toContain('Boo Zero')
  })

  it('OpenClaw LEADER turn: delegate-protocol block + [About the User], no worker guardrail', () => {
    const ctx = buildServerTeamContext(db, 'T', 'ocagent', true) ?? ''
    expect(ctx).toContain(OPENCLAW_BLOCK)
    expect(ctx).toContain(ABOUT_USER)
    expect(ctx).not.toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(LEADER_BLOCK)
  })

  it('OpenClaw WORKER turn: delegate-protocol block + worker guardrail, NO [About the User]', () => {
    const ctx = buildServerTeamContext(db, 'T', 'ocagent', false) ?? ''
    expect(ctx).toContain(OPENCLAW_BLOCK) // anti-spawn preserved for a worker
    expect(ctx).toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(ABOUT_USER)
  })

  it('CODING-runtime LEADER turn (hermes/codex/claude-code): the team_delegate leader block', () => {
    // A coding leader is persona-inert — this block is its ONLY instruction channel.
    // It teaches the `team_delegate` MCP tool (attached to orchestrator-driven runs
    // via the TeamChat `delegate=1` binding), NOT native's local `delegate`.
    const leader = buildServerTeamContext(db, 'T', 'hlead', true) ?? ''
    expect(leader).toContain(LEADER_BLOCK)
    expect(leader).toContain(CODING_LEADER_TOOL)
    expect(leader).toContain(ABOUT_USER)
    expect(leader).not.toContain(WORKER_BLOCK)
    expect(leader).not.toContain(OPENCLAW_BLOCK)
  })

  it('coding-runtime WORKER turn: worker guardrail only — no leader block', () => {
    const worker = buildServerTeamContext(db, 'T', 'hlead', false) ?? ''
    expect(worker).toContain(WORKER_BLOCK)
    expect(worker).not.toContain(LEADER_BLOCK)
    expect(worker).not.toContain(CODING_LEADER_TOOL)
    expect(worker).not.toContain(OPENCLAW_BLOCK)
  })
})
