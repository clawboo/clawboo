// booZero — the runtime-NEUTRAL universal-leader resolution. Boo Zero is a designated
// role: `resolveBooZero` = override → native → OpenClaw; `booZeroForTeam` returns the
// per-runtime default for a team's base leader (OpenClaw Boo Zero for an OpenClaw team,
// the DEFAULT-NATIVE Boo Zero otherwise) unless a user override is set; and
// `ensureNativeBooZero` lazily creates the teamless native Boo Zero when a native key is
// connected.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createDb, getSetting, setSetting, teams, type ClawbooDb } from '@clawboo/db'

import { SETTING_DEFAULT_ID } from '../../agentSource/openClawAgentSource'
import { getDbPath } from '../../db'
import {
  booZeroForTeam,
  ensureNativeBooZero,
  resolveBooZero,
  resolveNativeBooZero,
  SETTING_BOO_ZERO_OVERRIDE,
  SETTING_NATIVE_BOO_ZERO_ID,
  SETTING_NATIVE_LEADER_MODEL,
} from '../booZero'

const NATIVE_KEY_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL']

describe('booZero', () => {
  let home: string
  let prevHome: string | undefined
  const savedKeys: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-boozero-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    // Clear ALL native provider keys so `hasConnectedNativeProvider` is deterministic
    // (the real env on the dev machine may carry a provider key).
    for (const v of NATIVE_KEY_VARS) {
      savedKeys[v] = process.env[v]
      delete process.env[v]
    }
    db = createDb(getDbPath())
    created = 0
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    for (const v of NATIVE_KEY_VARS) {
      if (savedKeys[v] === undefined) delete process.env[v]
      else process.env[v] = savedKeys[v]
    }
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function team(id: string, leaderAgentId: string | null = null): void {
    const now = Date.now()
    db.insert(teams)
      .values({ id, name: id, icon: '👻', color: '#fff', leaderAgentId, createdAt: now, updatedAt: now })
      .run()
  }
  function agent(id: string, teamId: string | null, runtime: string): void {
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

  // A fake native AgentSource that just inserts a teamless clawboo-native row.
  let created = 0
  const fakeNative = {
    createAgent: async (input: { name: string; teamId: string | null }) => {
      const id = `native-boo-zero-${++created}`
      agent(id, input.teamId, 'clawboo-native')
      return { id }
    },
  }

  it('resolveBooZero: override > native > OpenClaw', () => {
    agent('oc', null, 'openclaw')
    setSetting(db, SETTING_DEFAULT_ID, 'oc')
    expect(resolveBooZero(db)?.id).toBe('oc') // only OpenClaw → OpenClaw Boo Zero

    agent('nbz', null, 'clawboo-native')
    setSetting(db, SETTING_NATIVE_BOO_ZERO_ID, 'nbz')
    expect(resolveBooZero(db)?.id).toBe('nbz') // native wins over OpenClaw

    agent('override', null, 'claude-code')
    setSetting(db, SETTING_BOO_ZERO_OVERRIDE, 'override')
    expect(resolveBooZero(db)?.id).toBe('override') // override wins over everything
  })

  it('resolveNativeBooZero validates the row (rejects a stale/foreign marker)', () => {
    agent('oc', null, 'openclaw')
    setSetting(db, SETTING_NATIVE_BOO_ZERO_ID, 'oc') // points at an OpenClaw agent
    expect(resolveNativeBooZero(db)).toBeNull() // not a clawboo-native teamless agent → rejected
  })

  it('booZeroForTeam: the ONE native Boo Zero leads EVERY team — native AND OpenClaw', () => {
    agent('nbz', null, 'clawboo-native')
    setSetting(db, SETTING_NATIVE_BOO_ZERO_ID, 'nbz')
    agent('ocbz', null, 'openclaw')
    setSetting(db, SETTING_DEFAULT_ID, 'ocbz')
    team('t-native', 'nat-lead')
    agent('nat-lead', 't-native', 'clawboo-native')
    team('t-oc', 'oc-lead')
    agent('oc-lead', 't-oc', 'openclaw')
    // The native Boo Zero (native > OpenClaw) leads BOTH — one universal leader.
    expect(booZeroForTeam(db, 't-native')?.id).toBe('nbz')
    expect(booZeroForTeam(db, 't-oc')?.id).toBe('nbz')
  })

  it('booZeroForTeam: falls back to the OpenClaw Boo Zero when NO native one exists', () => {
    agent('ocbz', null, 'openclaw')
    setSetting(db, SETTING_DEFAULT_ID, 'ocbz')
    team('t-native', 'nat-lead')
    agent('nat-lead', 't-native', 'clawboo-native')
    // No native Boo Zero → the OpenClaw one is the only leader available.
    expect(booZeroForTeam(db, 't-native')?.id).toBe('ocbz')
  })

  it('booZeroForTeam: null when no Boo Zero exists at all → team keeps its own leader', () => {
    team('t-native', 'nat-lead')
    agent('nat-lead', 't-native', 'clawboo-native')
    expect(booZeroForTeam(db, 't-native')).toBeNull()
  })

  it('booZeroForTeam: an explicit override leads EVERY team, any runtime', () => {
    agent('override', null, 'clawboo-native')
    setSetting(db, SETTING_BOO_ZERO_OVERRIDE, 'override')
    team('t-oc', 'oc-lead')
    agent('oc-lead', 't-oc', 'openclaw')
    expect(booZeroForTeam(db, 't-oc')?.id).toBe('override')
  })

  // A native team exists (a native member) — native is in use.
  function seedNativeTeam(): void {
    team('t-native', 'nat-lead')
    agent('nat-lead', 't-native', 'clawboo-native')
  }

  it('ensureNativeBooZero: creates + designates a teamless native Boo Zero when native is in use + a key is connected (idempotent)', async () => {
    seedNativeTeam()
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key'
    const bz = await ensureNativeBooZero(db, fakeNative)
    expect(bz).not.toBeNull()
    expect(bz!.name).toBe('Boo Zero')
    expect(getSetting(db, SETTING_NATIVE_BOO_ZERO_ID)).toBe(bz!.id)
    expect(resolveNativeBooZero(db)?.id).toBe(bz!.id)
    // Idempotent: a second call returns the same one, no new row.
    const again = await ensureNativeBooZero(db, fakeNative)
    expect(again!.id).toBe(bz!.id)
    expect(created).toBe(1)
  })

  it('ensureNativeBooZero: uses the onboarding-chosen leader model (SETTING_NATIVE_LEADER_MODEL)', async () => {
    seedNativeTeam()
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key'
    setSetting(
      db,
      SETTING_NATIVE_LEADER_MODEL,
      JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    )
    let captured: Record<string, unknown> | undefined
    const capturingNative = {
      createAgent: async (input: { name: string; teamId: string | null; execConfig?: unknown }) => {
        captured = input.execConfig as Record<string, unknown>
        const id = `native-boo-zero-${++created}`
        agent(id, input.teamId, 'clawboo-native')
        return { id }
      },
    }
    const bz = await ensureNativeBooZero(db, capturingNative)
    expect(bz).not.toBeNull()
    // The chosen provider + model (+ its vault env-var) ride the execConfig; the auto-resolve
    // path (modelTier only, no primaryModel) is NOT taken.
    expect(captured).toMatchObject({
      primaryProvider: 'anthropic',
      primaryModel: 'claude-sonnet-4-6',
      envVar: 'ANTHROPIC_API_KEY',
    })
  })

  it('ensureNativeBooZero: creates NOTHING when no native provider key is connected', async () => {
    seedNativeTeam()
    // No key set (cleared in beforeEach) → no runnable native agent → no Boo Zero.
    const bz = await ensureNativeBooZero(db, fakeNative)
    expect(bz).toBeNull()
    expect(getSetting(db, SETTING_NATIVE_BOO_ZERO_ID)).toBeNull()
    expect(created).toBe(0)
  })

  it('ensureNativeBooZero: creates NOTHING for a pure-OpenClaw install (no native team member)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key' // key present, but native is NOT in use
    team('t-oc', 'oc-lead')
    agent('oc-lead', 't-oc', 'openclaw')
    const bz = await ensureNativeBooZero(db, fakeNative)
    expect(bz).toBeNull()
    expect(created).toBe(0)
  })
})
