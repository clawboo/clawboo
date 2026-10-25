// nativeTeamSession — the native leader session-resume pointer keys + the
// read/write eligibility gate (the amnesia-fix continuity bookkeeping). Pure.

import { describe, expect, it } from 'vitest'

import {
  nativeTeamSessionKeysForAgentLike,
  nativeTeamSessionKeysForRoomLike,
  nativeTeamSessionKeysForTeamLike,
  nativeTeamSessionRoomKeysForTeamLike,
  nativeTeamSessionSettingKey,
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
