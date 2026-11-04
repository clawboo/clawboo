// nativeTeamSession — the native leader session-resume pointer keys + the
// read/write eligibility gate (the amnesia-fix continuity bookkeeping). Pure.

import { describe, expect, it } from 'vitest'

import {
  nativeTeamSessionKeysForAgentLike,
  nativeTeamSessionKeysForRoomLike,
  nativeTeamSessionKeysForTeamLike,
  nativeTeamSessionRoomKeysForTeamLike,
  nativeTeamSessionSettingKey,
  encodeTaskSessionPointer,
  parseTaskSessionPointer,
  TASK_SESSION_KEYS_LIKE,
  taskResumeEligible,
  taskSessionKeysForTaskLike,
  taskSessionKeysForTeamLike,
  taskSessionSettingKey,
  teamResumeEligible,
} from '../nativeTeamSession'

describe('nativeTeamSession keys', () => {
  it('builds a per-(agent, team) pointer key', () => {
    expect(nativeTeamSessionSettingKey('native-bz-1', 'team-9')).toBe(
      'native-team-session:native-bz-1:team-9',
    )
  })

  it('is per-(agent, team) so Boo Zero cannot collide across teams / the 1:1 chat', () => {
    const a = nativeTeamSessionSettingKey('native-bz-1', 'team-a')
    const b = nativeTeamSessionSettingKey('native-bz-1', 'team-b')
    expect(a).not.toBe(b)
    // Distinct from the 1:1 `native-chat-session:<agentId>` namespace.
    expect(a.startsWith('native-team-session:')).toBe(true)
  })

  it('a chat room gets its own pointer; the default room keeps the original key', () => {
    expect(nativeTeamSessionSettingKey('native-bz-1', 'team-9', null)).toBe(
      'native-team-session:native-bz-1:team-9',
    )
    expect(nativeTeamSessionSettingKey('native-bz-1', 'team-9', 'room-3')).toBe(
      'native-team-session:native-bz-1:team-9:room:room-3',
    )
  })

  it('room sweep patterns reach the room pointers the team pattern does not', () => {
    const like = (pattern: string, key: string): boolean =>
      new RegExp(
        `^${pattern
          .split('%')
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ).test(key)
    const roomKey = nativeTeamSessionSettingKey('a1', 'team-9', 'room-3')
    const teamKey = nativeTeamSessionSettingKey('a1', 'team-9')
    expect(like(nativeTeamSessionKeysForTeamLike('team-9'), teamKey)).toBe(true)
    expect(like(nativeTeamSessionKeysForTeamLike('team-9'), roomKey)).toBe(false)
    expect(like(nativeTeamSessionRoomKeysForTeamLike('team-9'), roomKey)).toBe(true)
    expect(like(nativeTeamSessionRoomKeysForTeamLike('team-9'), teamKey)).toBe(false)
    expect(like(nativeTeamSessionKeysForRoomLike('team-9', 'room-3'), roomKey)).toBe(true)
    expect(like(nativeTeamSessionKeysForRoomLike('team-9', 'room-4'), roomKey)).toBe(false)
    // The agent pattern covers both, so an agent delete sweeps every room.
    expect(like(nativeTeamSessionKeysForAgentLike('a1'), roomKey)).toBe(true)
    expect(like(nativeTeamSessionKeysForAgentLike('a1'), teamKey)).toBe(true)
  })

  it('builds team + agent LIKE sweep patterns', () => {
    expect(nativeTeamSessionKeysForTeamLike('team-9')).toBe('native-team-session:%:team-9')
    expect(nativeTeamSessionKeysForAgentLike('native-bz-1')).toBe(
      'native-team-session:native-bz-1:%',
    )
  })
})

describe('teamResumeEligible', () => {
  const base = {
    runtime: 'clawboo-native',
    homeDir: '/home/x',
    isTeamSession: true,
    isTaskRun: false,
  }

  it('true for a native leader / user-facing team session with a persistent home', () => {
    expect(teamResumeEligible(base)).toBe(true)
  })

  it('false for a delegated CHILD task run (its continuity is the executor handoff path)', () => {
    expect(teamResumeEligible({ ...base, isTaskRun: true })).toBe(false)
  })

  it('false without a persistent home (nothing to reload)', () => {
    expect(teamResumeEligible({ ...base, homeDir: null })).toBe(false)
  })

  it('false for a non-team (1:1) session (that path uses native-chat-session)', () => {
    expect(teamResumeEligible({ ...base, isTeamSession: false })).toBe(false)
  })

  it('true for a CODEX leader turn — the ChatGPT-subscription leader resumes via `codex exec resume`', () => {
    expect(teamResumeEligible({ ...base, runtime: 'codex' })).toBe(true)
    // Same child/home/session gates apply to codex as to native.
    expect(teamResumeEligible({ ...base, runtime: 'codex', isTaskRun: true })).toBe(false)
    expect(teamResumeEligible({ ...base, runtime: 'codex', homeDir: null })).toBe(false)
  })

  it('false for a runtime outside the pointer scheme (hermes / claude-code / unknown)', () => {
    expect(teamResumeEligible({ ...base, runtime: 'hermes' })).toBe(false)
    expect(teamResumeEligible({ ...base, runtime: 'claude-code' })).toBe(false)
    expect(teamResumeEligible({ ...base, runtime: null })).toBe(false)
  })
})

// Per-task resume pointers: a board task run continues the agent's own earlier
// session on that task. Only the pointer is per task; the engine's session key
// stays one per (agent, room).
describe('task session pointers', () => {
  const like = (pattern: string, key: string): boolean =>
    new RegExp(
      `^${pattern
        .split('%')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    ).test(key)

  it('keys a pointer by agent, team and task, under the existing prefix', () => {
    expect(taskSessionSettingKey('a1', 'team-9', 'task-7')).toBe(
      'native-team-session:a1:team-9:task:task-7',
    )
  })

  it('every sweep reaches it: per task, per team, per agent, and the boot sweep', () => {
    const key = taskSessionSettingKey('a1', 'team-9', 'task-7')
    expect(like(taskSessionKeysForTaskLike('task-7'), key)).toBe(true)
    expect(like(taskSessionKeysForTaskLike('task-8'), key)).toBe(false)
    expect(like(taskSessionKeysForTeamLike('team-9'), key)).toBe(true)
    expect(like(taskSessionKeysForTeamLike('team-8'), key)).toBe(false)
    expect(like(TASK_SESSION_KEYS_LIKE, key)).toBe(true)
    // The agent sweep that already existed covers it, so an agent delete does.
    expect(like(nativeTeamSessionKeysForAgentLike('a1'), key)).toBe(true)
  })

  it('stays out of the leader and room sweeps', () => {
    const key = taskSessionSettingKey('a1', 'team-9', 'task-7')
    expect(like(nativeTeamSessionKeysForTeamLike('team-9'), key)).toBe(false)
    expect(like(nativeTeamSessionRoomKeysForTeamLike('team-9'), key)).toBe(false)
    expect(like(TASK_SESSION_KEYS_LIKE, nativeTeamSessionSettingKey('a1', 'team-9'))).toBe(false)
    expect(like(TASK_SESSION_KEYS_LIKE, nativeTeamSessionSettingKey('a1', 'team-9', 'r'))).toBe(
      false,
    )
  })

  it('round-trips its value, and reads anything malformed as no pointer', () => {
    const p = { sessionId: 's-1', runtime: 'codex', ticketHash: 'h', seenAt: 42 }
    expect(parseTaskSessionPointer(encodeTaskSessionPointer(p))).toEqual(p)
    for (const bad of [
      null,
      '',
      'not json',
      '{}',
      '{"sessionId":"","runtime":"codex","ticketHash":"h","seenAt":1}',
      '{"sessionId":"s","runtime":"codex","ticketHash":"h","seenAt":"x"}',
    ])
      expect(parseTaskSessionPointer(bad)).toBeNull()
  })
})

describe('taskResumeEligible', () => {
  const home = '/home/x'
  it('resumes Native, Codex and Hermes from their own home', () => {
    for (const runtime of ['clawboo-native', 'codex', 'hermes'])
      expect(taskResumeEligible({ runtime, homeDir: home, isTeamSession: true })).toBe(true)
  })

  it('needs that home, since the session lives in it', () => {
    for (const runtime of ['clawboo-native', 'codex', 'hermes'])
      expect(taskResumeEligible({ runtime, homeDir: null, isTeamSession: true })).toBe(false)
  })

  it('resumes Claude Code with no home: its sessions live with the team folder every team run starts in', () => {
    expect(taskResumeEligible({ runtime: 'claude-code', homeDir: null, isTeamSession: true })).toBe(
      true,
    )
  })

  it('never resumes OpenClaw: its runtime session is the team session itself', () => {
    expect(taskResumeEligible({ runtime: 'openclaw', homeDir: home, isTeamSession: true })).toBe(
      false,
    )
  })

  it('only on a team session, and never for an unknown runtime', () => {
    expect(taskResumeEligible({ runtime: 'codex', homeDir: home, isTeamSession: false })).toBe(
      false,
    )
    expect(taskResumeEligible({ runtime: null, homeDir: home, isTeamSession: true })).toBe(false)
    expect(taskResumeEligible({ runtime: 'mock', homeDir: home, isTeamSession: true })).toBe(false)
  })
})
