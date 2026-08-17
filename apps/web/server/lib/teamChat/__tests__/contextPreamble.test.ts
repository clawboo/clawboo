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

import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { agents, setSetting, teams, type ClawbooDb } from '@clawboo/db'
import type { TurnFraming } from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
import { saveAgentConfig } from '../../runtimes/native/agentConfigStore'
import { buildServerTeamContext } from '../contextPreamble'

const LEADER_BLOCK = '[Leading this team' // shared framing (native AND coding leaders)
const CODING_LEADER_TOOL = 'team_delegate' // the coding leader block's tool (MCP)
const WORKER_BLOCK = '[Your task'
const OPENCLAW_BLOCK = '[How this team works'
const ABOUT_USER = '[About the User]'
const AWARENESS_BLOCK = '[Staying in sync with your teammates]'

// The four framings. These were two — `isLeaderTurn` and its negation — and the
// two turns that are NEITHER (a specialist the user @mentioned, an idle agent
// receiving a system message) were silently framed as the team lead.
const LEADER: TurnFraming = { isLeader: true, isWorker: false, isUserFacing: true }
const WORKER: TurnFraming = { isLeader: false, isWorker: true, isUserFacing: false }
const MENTIONED: TurnFraming = { isLeader: false, isWorker: false, isUserFacing: true }
const IDLE_SYSTEM: TurnFraming = { isLeader: false, isWorker: false, isUserFacing: false }

describe('buildServerTeamContext coordination blocks', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-ctx-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
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
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('LEADER turn: native leader block + [About the User], no worker guardrail', () => {
    const ctx = buildServerTeamContext(db, 'T', 'nlead', LEADER) ?? ''
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
    const ctx = buildServerTeamContext(db, 'T', 'nwork', WORKER) ?? ''
    expect(ctx).toContain(WORKER_BLOCK)
    expect(ctx).toContain('You CANNOT reach the user')
    expect(ctx).not.toContain(ABOUT_USER) // the user intro is leader-only
    expect(ctx).not.toContain(LEADER_BLOCK)
    // the roster is still present (the worker still sees teammate names)
    expect(ctx).toContain('Boo Zero')
  })

  it('OpenClaw LEADER turn: delegate-protocol block + [About the User], no worker guardrail', () => {
    const ctx = buildServerTeamContext(db, 'T', 'ocagent', LEADER) ?? ''
    expect(ctx).toContain(OPENCLAW_BLOCK)
    expect(ctx).toContain(ABOUT_USER)
    expect(ctx).not.toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(LEADER_BLOCK)
  })

  it('teaches the team room to a native agent that has it', () => {
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'nlead',
      tools: { memory: true, tools: true, tasks: 'read', teamchat: true },
    })
    const ctx = buildServerTeamContext(db, 'T', 'nlead', LEADER) ?? ''
    expect(ctx).toContain(AWARENESS_BLOCK)
    expect(ctx).toContain('team_chat_post')
    expect(ctx).toContain('team_chat_subscribe')
    expect(ctx).toContain('list_tasks')
  })

  it('stays silent for a native agent whose room is switched OFF', () => {
    // Naming a tool the run does not have is worse than saying nothing — the
    // model calls it and gets an unknown-tool error.
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'nlead',
      tools: { memory: true, tools: true, tasks: false, teamchat: false },
    })
    expect(buildServerTeamContext(db, 'T', 'nlead', LEADER) ?? '').not.toContain(AWARENESS_BLOCK)
  })

  it('teaches the room to a native agent with NO stored config (the run path defaults it on)', () => {
    // The run resolves config with `loadAgentConfigOrDefault`, whose default has
    // `teamchat: true` — so the room really is attached and must be taught.
    expect(buildServerTeamContext(db, 'T', 'nwork', WORKER) ?? '').toContain(AWARENESS_BLOCK)
  })

  it('teaches the team room to coding runtimes (MCP-attached + bound on team runs)', () => {
    // Both roles: a worker needs the room as much as a leader — it is how it
    // learns what changed while it was busy.
    expect(buildServerTeamContext(db, 'T', 'hlead', LEADER) ?? '').toContain(AWARENESS_BLOCK)
    expect(buildServerTeamContext(db, 'T', 'hlead', WORKER) ?? '').toContain(AWARENESS_BLOCK)
  })

  it('never names the ROOM tools to an OpenClaw agent — it deliberately has none', () => {
    // TeamChat is not registered in the Gateway config: that config is
    // process-wide, so a static URL can't carry a per-run author binding, and an
    // unbound team_chat_post would let an agent post as ANY author. OpenClaw room
    // participation is server-mediated instead. The BOARD tools are registered,
    // so those are still taught — the two axes are gated independently.
    for (const isLeader of [true, false]) {
      const ctx = buildServerTeamContext(db, 'T', 'ocagent', isLeader ? LEADER : WORKER) ?? ''
      expect(ctx).not.toContain('team_chat_post')
      expect(ctx).not.toContain('team_chat_subscribe')
      expect(ctx).toContain('list_tasks')
    }
  })

  it('OpenClaw WORKER turn: delegate-protocol block + worker guardrail, NO [About the User]', () => {
    const ctx = buildServerTeamContext(db, 'T', 'ocagent', WORKER) ?? ''
    expect(ctx).toContain(OPENCLAW_BLOCK) // anti-spawn preserved for a worker
    expect(ctx).toContain(WORKER_BLOCK)
    expect(ctx).not.toContain(ABOUT_USER)
  })

  it('CODING-runtime LEADER turn (hermes/codex/claude-code): the team_delegate leader block', () => {
    // A coding leader is persona-inert — this block is its ONLY instruction channel.
    // It teaches the `team_delegate` MCP tool (attached to orchestrator-driven runs
    // via the TeamChat `delegate=1` binding), NOT native's local `delegate`.
    const leader = buildServerTeamContext(db, 'T', 'hlead', LEADER) ?? ''
    expect(leader).toContain(LEADER_BLOCK)
    expect(leader).toContain(CODING_LEADER_TOOL)
    expect(leader).toContain(ABOUT_USER)
    expect(leader).not.toContain(WORKER_BLOCK)
    expect(leader).not.toContain(OPENCLAW_BLOCK)
  })

  it('an @MENTIONED specialist: the user intro, but it is NOT told it leads', () => {
    // The user is talking to it, so the intro belongs. It is not the lead, so
    // "You are the LEAD of this team" does not — and it is not executing a
    // delegated task either, so "You CANNOT reach the user" would be a lie.
    const ctx = buildServerTeamContext(db, 'T', 'hlead', MENTIONED) ?? ''
    expect(ctx).toContain(ABOUT_USER)
    expect(ctx).toContain('I am a PM')
    expect(ctx).not.toContain(LEADER_BLOCK)
    expect(ctx).not.toContain(WORKER_BLOCK)
    expect(ctx).toContain('Boo Zero') // still sees the roster
  })

  it('an IDLE agent receiving a system message gets neither block and no intro', () => {
    // The bug this framing exists for: a `[Task Update]` arriving after the
    // agent's own task was forgotten used to hand it the leader block AND the
    // user's personal intro.
    const ctx = buildServerTeamContext(db, 'T', 'nwork', IDLE_SYSTEM) ?? ''
    expect(ctx).not.toContain(ABOUT_USER)
    expect(ctx).not.toContain(LEADER_BLOCK)
    expect(ctx).not.toContain(WORKER_BLOCK)
  })

  it('coding-runtime WORKER turn: worker guardrail only — no leader block', () => {
    const worker = buildServerTeamContext(db, 'T', 'hlead', WORKER) ?? ''
    expect(worker).toContain(WORKER_BLOCK)
    expect(worker).not.toContain(LEADER_BLOCK)
    expect(worker).not.toContain(CODING_LEADER_TOOL)
    expect(worker).not.toContain(OPENCLAW_BLOCK)
  })
})
