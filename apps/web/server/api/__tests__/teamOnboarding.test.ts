// teamOnboardingGET — the "Know Your Team" gate state. Asserts the read-time override:
// a team that already has chat history is reported as onboarded (so its group chat opens
// to the transcript instead of re-gating), while a brand-new team keeps the gate.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chatMessages, createDb, setSetting, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'

import { teamOnboardingGET } from '../teamOnboarding'
import { getDbPath } from '../../lib/db'

const TEAM = 'team-1'

function fakeRes(): { res: Response; body: () => unknown; status: () => number } {
  let status = 200
  let body: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      body = b
      return this
    },
  } as unknown as Response
  return { res, body: () => body, status: () => status }
}

describe('teamOnboardingGET — chat-history override', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb
  let seq = 0

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-onboarding-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = createDb(getDbPath())
    seq = 0
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function setOnboarding(teamId: string, state: object): void {
    setSetting(db, `team-onboarding:${teamId}`, JSON.stringify(state))
  }
  function seedChat(sessionKey: string): void {
    seq += 1
    db.insert(chatMessages)
      .values({
        sessionKey,
        gatewayUrl: 'native',
        entryId: `e${seq}`,
        timestampMs: seq,
        data: JSON.stringify({ entryId: `e${seq}`, sessionKey, text: 'hi', kind: 'assistant' }),
      })
      .run()
  }

  async function get(teamId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { res, body, status } = fakeRes()
    teamOnboardingGET({ params: { id: teamId } } as unknown as Request, res)
    // handler is synchronous, but await a tick for safety
    await Promise.resolve()
    return { status: status(), body: body() as Record<string, unknown> }
  }

  it('a brand-new team (no chat) keeps the gate (userIntroduced stays false)', async () => {
    setOnboarding(TEAM, { agentsIntroduced: true, userIntroduced: false, userIntroText: '' })
    const { status, body } = await get(TEAM)
    expect(status).toBe(200)
    expect(body['userIntroduced']).toBe(false)
  })

  it('a team WITH chat history is reported onboarded (gate skips), intro text preserved', async () => {
    setOnboarding(TEAM, {
      agentsIntroduced: true,
      userIntroduced: false,
      userIntroText: 'this is your boss',
    })
    seedChat(`agent:some-member:team:${TEAM}`)
    const { body } = await get(TEAM)
    expect(body['agentsIntroduced']).toBe(true)
    expect(body['userIntroduced']).toBe(true) // <-- the override
    expect(body['userIntroText']).toBe('this is your boss') // preserved
  })

  it('another team’s chat does not leak the override (scoped by :team:<id>)', async () => {
    setOnboarding(TEAM, { agentsIntroduced: true, userIntroduced: false, userIntroText: '' })
    seedChat('agent:x:team:other-team') // different team
    const { body } = await get(TEAM)
    expect(body['userIntroduced']).toBe(false)
  })

  it('an already-fully-onboarded team is returned as-is', async () => {
    setOnboarding(TEAM, { agentsIntroduced: true, userIntroduced: true, userIntroText: 'boss' })
    const { body } = await get(TEAM)
    expect(body['userIntroduced']).toBe(true)
  })
})
