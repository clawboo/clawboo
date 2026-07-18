// GET /api/onboarding/state — the aggregated first-run signals. Sandboxes $HOME +
// CLAWBOO_HOME + OPENCLAW_STATE_DIR so the sqlite db, the vault, and the OpenClaw
// state dir are throwaway (config/env files absent ⇒ `configured` is false
// regardless of whether the openclaw binary is on PATH).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { setRuntimeSecret } from '../../lib/secretsVault'
import { onboardingStateGET } from '../onboardingState'

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
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
  return { res, status: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

interface StateBody {
  configured: boolean
  hasNative: boolean
  hasTeam: boolean
  hasConnectedRuntime: boolean
}

describe('GET /api/onboarding/state', () => {
  let home: string
  let prevHome: string | undefined
  let prevStateDir: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-onboarding-state-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    await mkdir(path.join(home, '.openclaw'), { recursive: true })
    prevHome = process.env['HOME']
    prevStateDir = process.env['OPENCLAW_STATE_DIR']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    process.env['OPENCLAW_STATE_DIR'] = path.join(home, '.openclaw')
    // Keep the hermes ChatGPT-login probe sandboxed (userHermesHome honours
    // HERMES_HOME first, else ~/.hermes under the sandboxed HOME).
    delete process.env['HERMES_HOME']
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR']
    else process.env['OPENCLAW_STATE_DIR'] = prevStateDir
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('reports the fresh-install shape (all false)', async () => {
    // Touch the db so it exists (empty). No teams / native agents / vault keys.
    createDb(getDbPath())
    const r = mockRes()
    await onboardingStateGET(req(), r.res)
    expect(r.status()).toBe(200)
    const body = r.body() as StateBody
    expect(body).toEqual({
      configured: false, // openclaw config/env files absent in the sandbox
      hasNative: false,
      hasTeam: false,
      hasConnectedRuntime: false,
    })
  })

  it('flips hasTeam + hasNative once a native team is seeded', async () => {
    const db = createDb(getDbPath())
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 't1',
        name: 'My First Team',
        icon: '👻',
        color: '#fff',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values({
        id: 'native-leader-abc',
        name: 'Team Lead',
        gatewayId: 'native-leader-abc',
        sourceId: 'clawboo-native',
        sourceAgentId: 'native-leader-abc',
        runtime: 'clawboo-native',
        status: 'idle',
        teamId: 't1',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const r = mockRes()
    await onboardingStateGET(req(), r.res)
    const body = r.body() as StateBody
    expect(body.hasTeam).toBe(true)
    expect(body.hasNative).toBe(true)
    expect(body.configured).toBe(false)
    expect(body.hasConnectedRuntime).toBe(false)
  })

  it('flips hasConnectedRuntime when a runtime key is stored in the vault', async () => {
    createDb(getDbPath())
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-vault-test')
    const r = mockRes()
    await onboardingStateGET(req(), r.res)
    const body = r.body() as StateBody
    expect(body.hasConnectedRuntime).toBe(true)
  })

  it('flips hasConnectedRuntime on a hermes ChatGPT login (no vault key at all)', async () => {
    const { writeFile } = await import('node:fs/promises')
    await mkdir(path.join(home, '.hermes'), { recursive: true })
    await writeFile(
      path.join(home, '.hermes', 'auth.json'),
      JSON.stringify({
        providers: { 'openai-codex': { tokens: { access_token: 'at', refresh_token: 'rt' } } },
      }),
    )
    const m = mockRes()
    await onboardingStateGET(req(), m.res)
    // Without this signal a hermes-login-only user reads hasConnectedRuntime=false
    // and the reload decision re-traps them in a fresh wizard.
    expect((m.body() as StateBody).hasConnectedRuntime).toBe(true)
  })
})
