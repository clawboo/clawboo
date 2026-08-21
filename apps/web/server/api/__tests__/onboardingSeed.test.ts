// Onboarding native-team seed REST. Sandboxes CLAWBOO_HOME (fresh DB per test)
// and drives onboardingSeedNativeTeamPOST against the REAL native AgentSource —
// asserting the team row + two native agents + the pre-satisfied "Know Your
// Team" onboarding flags, a 400 for an unknown provider, and the provider-less
// resolution ladder (recorded pick when connected → first connected provider →
// anthropic fallback). Provider env vars are cleared per test so a developer's
// ambient keys cannot change what "connected" means here.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_AGENT_CONFIG, NATIVE_PROVIDER_ENV_VARS } from '@clawboo/adapter-native'
import { getSetting, setSetting, agents, teams } from '@clawboo/db'

import {
  onboardingNativeLeaderModelGET,
  onboardingNativeLeaderModelPOST,
  onboardingSeedNativeTeamPOST,
} from '../onboardingSeed'
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

describe('onboarding seed-native-team REST', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  // The provider env vars are saved + CLEARED per test (not just restored): with
  // CLAWBOO_HOME sandboxed the vault is empty, so the process env is the only
  // place a "connected" key can come from, and it must be one this test set.
  const SAVED: readonly string[] = [
    'CLAWBOO_HOME',
    'OPENCLAW_STATE_DIR',
    'OLLAMA_BASE_URL',
    ...NATIVE_PROVIDER_ENV_VARS,
  ]

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-seed-'))
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = mkdtempSync(path.join(os.tmpdir(), 'clawboo-seed-state-'))
    delete process.env['OLLAMA_BASE_URL']
    for (const k of NATIVE_PROVIDER_ENV_VARS) delete process.env[k]
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

  it('seeds a team with a leader + specialist native agent and pre-satisfies onboarding', async () => {
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({ provider: 'anthropic' }), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { teamId: string; leaderAgentId: string; specialistAgentId: string }
    expect(out.teamId).toBeTruthy()
    expect(out.leaderAgentId).toMatch(/^native-/)
    expect(out.specialistAgentId).toMatch(/^native-/)
    expect(out.leaderAgentId).not.toBe(out.specialistAgentId)

    const db = getDb()

    // The team row exists with the leader recorded.
    const team = db.select().from(teams).where(eq(teams.id, out.teamId)).get()
    expect(team).toBeTruthy()
    expect(team?.leaderAgentId).toBe(out.leaderAgentId)

    // Exactly two native agents, both on the team.
    const members = db.select().from(agents).where(eq(agents.teamId, out.teamId)).all()
    expect(members).toHaveLength(2)
    for (const a of members) {
      expect(a.sourceId).toBe('clawboo-native')
      expect(a.runtime).toBe('clawboo-native')
    }

    // The "Know Your Team" gate is pre-satisfied so the user lands in chat.
    const onboarding = getSetting(db, `team-onboarding:${out.teamId}`)
    expect(onboarding).toBeTruthy()
    const flags = JSON.parse(onboarding ?? '{}') as {
      agentsIntroduced?: boolean
      userIntroduced?: boolean
    }
    expect(flags.agentsIntroduced).toBe(true)
    expect(flags.userIntroduced).toBe(true)
  })

  it('falls back to anthropic when no provider is supplied and NOTHING is connected', async () => {
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { teamId: string; leaderAgentId: string }
    expect(out.teamId).toBeTruthy()
    const cfg = loadAgentConfig(getDb(), out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('anthropic')
    expect(cfg?.envVar).toBe('ANTHROPIC_API_KEY')
  })

  it('seeds the CONNECTED provider when no provider is supplied (the silent-team bug)', async () => {
    // The 0.3.1-era failure: an OpenRouter-only user seeded an anthropic team
    // that looked healthy and never ran. A bare {} seed must follow the key.
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string; specialistAgentId: string }
    const db = getDb()
    const leader = loadAgentConfig(db, out.leaderAgentId)
    expect(leader?.primaryProvider).toBe('openrouter')
    expect(leader?.envVar).toBe('OPENROUTER_API_KEY')
    expect(leader?.primaryModel).toBe('anthropic/claude-haiku-4.5')
    const specialist = loadAgentConfig(db, out.specialistAgentId)
    expect(specialist?.primaryProvider).toBe('openrouter')
    expect(specialist?.envVar).toBe('OPENROUTER_API_KEY')
    expect(specialist?.primaryModel).toBe('openai/gpt-4o-mini')
    // The derived pick is recorded for the lazily-created Boo Zero (none existed).
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
    })
  })

  it('seeds keyless Ollama when only OLLAMA_BASE_URL is configured', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://localhost:11434'
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string }
    const cfg = loadAgentConfig(getDb(), out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('ollama')
    expect(cfg?.envVar).toBe('OLLAMA_BASE_URL')
  })

  it('honors the recorded leader-model pick when its provider is still connected', async () => {
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    const db = getDb()
    setSetting(
      db,
      SETTING_NATIVE_LEADER_MODEL,
      JSON.stringify({ provider: 'openrouter', model: 'minimax/m2.5' }),
    )
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string }
    const cfg = loadAgentConfig(db, out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('openrouter')
    expect(cfg?.primaryModel).toBe('minimax/m2.5')
    expect(cfg?.envVar).toBe('OPENROUTER_API_KEY')
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'openrouter',
      model: 'minimax/m2.5',
    })
  })

  it('a body model overrides the recorded pick WITHOUT re-recording the setting', async () => {
    // The override rides the recorded pick's provider, and the recorded model is
    // left alone. Asserted with a DIFFERENT model than the recorded one so a
    // regression that re-records (or that lets the recorded model win) is caught:
    // with a matching model both mistakes would write byte-identical values.
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    const db = getDb()
    setSetting(
      db,
      SETTING_NATIVE_LEADER_MODEL,
      JSON.stringify({ provider: 'openrouter', model: 'minimax/m2.5' }),
    )
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({ model: 'z-ai/glm-5' }), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string }
    const cfg = loadAgentConfig(db, out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('openrouter')
    expect(cfg?.primaryModel).toBe('z-ai/glm-5')
    // The user's recorded Boo Zero pick is NOT stomped by this team's override.
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'openrouter',
      model: 'minimax/m2.5',
    })
  })

  it('a body model rides the DERIVED provider and is recorded when nothing was set', async () => {
    process.env['OPENAI_API_KEY'] = 'oa-test-key'
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({ model: 'gpt-4.1-mini' }), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string; specialistAgentId: string }
    const db = getDb()
    const leader = loadAgentConfig(db, out.leaderAgentId)
    expect(leader?.primaryProvider).toBe('openai')
    expect(leader?.envVar).toBe('OPENAI_API_KEY')
    expect(leader?.primaryModel).toBe('gpt-4.1-mini')
    // The override applies to the LEADER only; the specialist keeps its default.
    expect(loadAgentConfig(db, out.specialistAgentId)?.primaryModel).toBe('gpt-4o-mini')
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
    })
  })

  it('does NOT record the anthropic fallback as a durable pick when nothing is connected', async () => {
    // Persisting the fallback would hand the lazily-created Boo Zero a provider
    // the user never chose, which a later connect of another key would not fix.
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    expect(getSetting(getDb(), SETTING_NATIVE_LEADER_MODEL)).toBeFalsy()
  })

  it('honors a recorded OLLAMA pick even without OLLAMA_BASE_URL, with a cloud key present', async () => {
    // A deliberate local-model choice must not be swapped for a billed provider.
    // The router always builds an ollama candidate (ollamaBaseUrl defaults to
    // localhost), so an ollama pick is runnable whether or not the env var is
    // set; only the "has the user set anything up at all" gate needs that signal.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
    const db = getDb()
    setSetting(
      db,
      SETTING_NATIVE_LEADER_MODEL,
      JSON.stringify({ provider: 'ollama', model: 'llama3.2' }),
    )
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string }
    const cfg = loadAgentConfig(db, out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('ollama')
    expect(cfg?.primaryModel).toBe('llama3.2')
    expect(cfg?.envVar).toBe('OLLAMA_BASE_URL')
  })

  it('skips a recorded pick whose key is NOT connected, without stomping the setting', async () => {
    process.env['OPENAI_API_KEY'] = 'oa-test-key'
    const db = getDb()
    setSetting(
      db,
      SETTING_NATIVE_LEADER_MODEL,
      JSON.stringify({ provider: 'openrouter', model: 'minimax/m2.5' }),
    )
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string }
    const cfg = loadAgentConfig(db, out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('openai')
    expect(cfg?.envVar).toBe('OPENAI_API_KEY')
    // The user's recorded (currently disconnected) pick survives for when the
    // key comes back; a derived pick never overwrites a recorded one.
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'openrouter',
      model: 'minimax/m2.5',
    })
  })

  it('an explicit provider still wins over both the recorded pick and connected keys', async () => {
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    const db = getDb()
    setSetting(
      db,
      SETTING_NATIVE_LEADER_MODEL,
      JSON.stringify({ provider: 'openrouter', model: 'minimax/m2.5' }),
    )
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({ provider: 'anthropic' }), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { leaderAgentId: string }
    const cfg = loadAgentConfig(db, out.leaderAgentId)
    expect(cfg?.primaryProvider).toBe('anthropic')
    expect(cfg?.envVar).toBe('ANTHROPIC_API_KEY')
    // An explicit seed is a deliberate pick and DOES re-record the setting.
    expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })

  it('treats an UNUSABLE recorded pick as absent, and records the derived one', async () => {
    // A stored `{provider:'',model:''}` (or an unknown provider) is not a pick that
    // merely cannot run: it is no pick at all. Reading it as present would both fail
    // to supply a provider AND block the usable derived one from ever being written,
    // leaving the lazily-created Boo Zero with nothing corrected.
    process.env['OPENROUTER_API_KEY'] = 'or-test-key'
    const db = getDb()
    for (const junk of [
      { provider: '', model: '' },
      { provider: 'not-a-provider', model: 'x' },
      { provider: 'openrouter', model: '   ' },
    ]) {
      setSetting(db, SETTING_NATIVE_LEADER_MODEL, JSON.stringify(junk))
      const m = mockRes()
      await onboardingSeedNativeTeamPOST(req({}), m.res)
      expect(m.statusCode(), JSON.stringify(junk)).toBe(201)
      const out = m.body() as { leaderAgentId: string }
      expect(loadAgentConfig(db, out.leaderAgentId)?.primaryProvider).toBe('openrouter')
      // The derived pick REPLACES the unusable one rather than being suppressed by it.
      expect(JSON.parse(getSetting(db, SETTING_NATIVE_LEADER_MODEL) ?? '{}')).toEqual({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-4.5',
      })
    }
  })

  it('rejects an unknown provider with 400', async () => {
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({ provider: 'not-a-provider' }), m.res)
    expect(m.statusCode()).toBe(400)
  })
})

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
