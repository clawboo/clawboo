// The ONE-SHOT coordination-toolset repair.
//
// Agents created before the coordination overhaul were frozen with
// `{tasks:false, teamchat:false}`, which switched off the whole coordination
// plane: the conversation's automatic peer-inbox pull became a no-op and a
// leader could not read the board it presided over. `ensureSchema` reconciles
// COLUMNS, never a frozen row's data, so existing installs are repaired once at
// boot instead.
//
// The load-bearing property under test: it is a ONE-SHOT, not a load-time
// coercion. After it runs, a user who turns these tools off keeps them off.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_CONFIG, type AgentConfig } from '@clawboo/adapter-native'
import { getSetting, type ClawbooDb } from '@clawboo/db'

import { getDb, resetDb } from '../../../db'
import {
  loadAgentConfig,
  saveAgentConfig,
  SETTING_COORDINATION_TOOLSET_UPGRADED,
  upgradeFrozenToolsets,
} from '../agentConfigStore'

const FROZEN = { memory: true, tools: true, tasks: false, teamchat: false } as const

const configWith = (id: string, tools: AgentConfig['tools']): AgentConfig => ({
  ...DEFAULT_AGENT_CONFIG,
  id,
  tools,
})

describe('upgradeFrozenToolsets (one-shot)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-toolset-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
  })

  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('repairs a frozen config to board-read + team room', () => {
    saveAgentConfig(db, configWith('a1', { ...FROZEN }))
    expect(upgradeFrozenToolsets(db)).toBe(1)
    expect(loadAgentConfig(db, 'a1')?.tools).toEqual({
      memory: true,
      tools: true,
      tasks: 'read',
      teamchat: true,
    })
  })

  it('leaves a deliberate toolset alone', () => {
    const deliberate = { memory: true, tools: true, tasks: true, teamchat: false }
    saveAgentConfig(db, configWith('a2', deliberate))
    upgradeFrozenToolsets(db)
    expect(loadAgentConfig(db, 'a2')?.tools).toEqual(deliberate)
  })

  it('runs only ONCE — a later opt-out is not re-overridden', () => {
    saveAgentConfig(db, configWith('a3', { ...FROZEN }))
    expect(upgradeFrozenToolsets(db)).toBe(1)
    expect(getSetting(db, SETTING_COORDINATION_TOOLSET_UPGRADED)).toBeTruthy()

    // The user deliberately turns the coordination tools back off.
    saveAgentConfig(db, configWith('a3', { ...FROZEN }))
    expect(upgradeFrozenToolsets(db)).toBe(0)
    expect(loadAgentConfig(db, 'a3')?.tools).toEqual(FROZEN)
  })

  it('repairs every frozen agent in one pass and is a no-op with none', () => {
    saveAgentConfig(db, configWith('b1', { ...FROZEN }))
    saveAgentConfig(db, configWith('b2', { ...FROZEN }))
    saveAgentConfig(
      db,
      configWith('b3', { memory: true, tools: true, tasks: 'read', teamchat: true }),
    )
    expect(upgradeFrozenToolsets(db)).toBe(2)
    expect(loadAgentConfig(db, 'b1')?.tools.teamchat).toBe(true)
    expect(loadAgentConfig(db, 'b2')?.tools.teamchat).toBe(true)
  })
})
