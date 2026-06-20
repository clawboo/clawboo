// Onboarding native-team seed REST. Sandboxes CLAWBOO_HOME (fresh DB per test)
// and drives onboardingSeedNativeTeamPOST against the REAL native AgentSource —
// asserting the team row + two native agents + the pre-satisfied "Know Your
// Team" onboarding flags, and a 400 for an unknown provider.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, getSetting, agents, teams } from '@clawboo/db'

import { onboardingSeedNativeTeamPOST } from '../onboardingSeed'
import { getDbPath } from '../../lib/db'

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
  const SAVED = ['CLAWBOO_HOME', 'OPENCLAW_STATE_DIR'] as const

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-seed-'))
    process.env['CLAWBOO_HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = mkdtempSync(path.join(os.tmpdir(), 'clawboo-seed-state-'))
  })
  afterEach(() => {
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

    const db = createDb(getDbPath())

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

  it('defaults to anthropic when no provider is supplied', async () => {
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({}), m.res)
    expect(m.statusCode()).toBe(201)
    const out = m.body() as { teamId: string }
    expect(out.teamId).toBeTruthy()
  })

  it('rejects an unknown provider with 400', async () => {
    const m = mockRes()
    await onboardingSeedNativeTeamPOST(req({ provider: 'not-a-provider' }), m.res)
    expect(m.statusCode()).toBe(400)
  })
})
