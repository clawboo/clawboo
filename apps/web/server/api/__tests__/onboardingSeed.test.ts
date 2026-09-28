// Onboarding native leader-model REST. Sandboxes CLAWBOO_HOME (fresh DB per test)
// and drives the POST / GET pair: the pick is recorded, validated, read back, and
// retro-applied to an existing native Boo Zero.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { getSetting, setSetting } from '@clawboo/db'

import { onboardingNativeLeaderModelGET, onboardingNativeLeaderModelPOST } from '../onboardingSeed'
import { getDb, resetDb } from '../../lib/db'
import { loadAgentConfig, saveAgentConfig } from '../../lib/runtimes/native/agentConfigStore'
import { SETTING_NATIVE_BOO_ZERO_ID, SETTING_NATIVE_LEADER_MODEL } from '../../lib/teamChat/booZero'

interface Mock {
  res: Response
  statusCode: () => number
  body: () => unknown
}
function mockRes(): Mock {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}
const req = (body: Record<string, unknown> = {}): Request =>
  ({ params: {}, query: {}, body }) as unknown as Request

describe('onboarding native-leader-model REST', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  const SAVED = ['CLAWBOO_HOME', 'OPENCLAW_STATE_DIR'] as const

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-lm-'))
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = mkdtempSync(path.join(os.tmpdir(), 'clawboo-lm-state-'))
  })
  afterEach(() => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('records the chosen provider + model to the leader-model setting', () => {
    const m = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'anthropic', model: 'claude-sonnet-5' }), m.res)
    expect(m.statusCode()).toBe(200)
    const db = getDb()
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })

  it('rejects an unknown provider (400) and a missing model (400)', () => {
    const bad = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'nope', model: 'x' }), bad.res)
    expect(bad.statusCode()).toBe(400)

    const noModel = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'anthropic' }), noModel.res)
    expect(noModel.statusCode()).toBe(400)
  })

  it('GET returns the stored default (and null/null when never set)', () => {
    const empty = mockRes()
    onboardingNativeLeaderModelGET(req({}), empty.res)
    expect(empty.body()).toEqual({ provider: null, model: null })

    onboardingNativeLeaderModelPOST(
      req({ provider: 'openrouter', model: 'minimax/m2.5' }),
      mockRes().res,
    )
    const m = mockRes()
    onboardingNativeLeaderModelGET(req({}), m.res)
    expect(m.body()).toEqual({ provider: 'openrouter', model: 'minimax/m2.5' })
  })

  it('POST retro-applies the pick to an EXISTING native Boo Zero AgentConfig', () => {
    const db = getDb()
    // Seed a native Boo Zero + its stored AgentConfig (the shape ensureNativeBooZero writes).
    setSetting(db, SETTING_NATIVE_BOO_ZERO_ID, 'native-bz-1')
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'native-bz-1',
      name: 'Boo Zero',
      primaryProvider: 'anthropic',
      primaryModel: 'claude-haiku-4-5',
      envVar: 'ANTHROPIC_API_KEY',
    })

    const m = mockRes()
    onboardingNativeLeaderModelPOST(req({ provider: 'openrouter', model: 'minimax/m2.5' }), m.res)
    expect(m.statusCode()).toBe(200)

    // The EXISTING leader now runs the pick — not just future lazily-created ones.
    const cfg = loadAgentConfig(db, 'native-bz-1')
    expect(cfg?.primaryProvider).toBe('openrouter')
    expect(cfg?.primaryModel).toBe('minimax/m2.5')
    expect(cfg?.envVar).toBe('OPENROUTER_API_KEY')
  })
})
