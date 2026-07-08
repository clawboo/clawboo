// resolveServerOrchestrated — after the OpenClaw cutover EVERY team is
// server-orchestrated: the result is TRUE unless a team explicitly opts out via
// `team-server-orchestrated:<id>='false'` (a defensive escape hatch nothing sets).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createDb, setSetting, teams, type ClawbooDb } from '@clawboo/db'

import { getDbPath } from '../../db'
import {
  resolveServerOrchestrated,
  serverOrchestratedSettingKey,
} from '../resolveServerOrchestrated'

describe('resolveServerOrchestrated', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-server-orch-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function team(id: string, leaderAgentId: string | null = null): void {
    const now = Date.now()
    db.insert(teams)
      .values({ id, name: id, icon: '👻', color: '#fff', leaderAgentId, createdAt: now, updatedAt: now })
      .run()
  }
  function agent(id: string, teamId: string, runtime: string): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: runtime,
        sourceAgentId: id,
        runtime,
        status: 'idle',
        teamId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  it('defaults to server-orchestrated (true) for an OpenClaw team — the cutover', () => {
    team('t1', 'a1')
    agent('a1', 't1', 'openclaw')
    expect(resolveServerOrchestrated(db, 't1')).toBe(true)
  })

  it('defaults to server-orchestrated (true) for a native team', () => {
    team('t2', 'a2')
    agent('a2', 't2', 'clawboo-native')
    expect(resolveServerOrchestrated(db, 't2')).toBe(true)
  })

  it('defaults to server-orchestrated (true) for a mixed / coding team', () => {
    team('t3', null)
    agent('a3', 't3', 'claude-code')
    expect(resolveServerOrchestrated(db, 't3')).toBe(true)
  })

  it('defaults to true even for an empty team (no members)', () => {
    team('t4', null)
    expect(resolveServerOrchestrated(db, 't4')).toBe(true)
  })

  it('the explicit "true" flag → true', () => {
    team('t5', 'a5')
    agent('a5', 't5', 'openclaw')
    setSetting(db, serverOrchestratedSettingKey('t5'), 'true')
    expect(resolveServerOrchestrated(db, 't5')).toBe(true)
  })

  it('the explicit "false" flag is the ONLY opt-out → false', () => {
    team('t6', 'a6')
    agent('a6', 't6', 'clawboo-native')
    setSetting(db, serverOrchestratedSettingKey('t6'), 'false')
    expect(resolveServerOrchestrated(db, 't6')).toBe(false)
  })
})
