// The invariant both dispatch paths owe the reader: markers stripped, one card
// per distinct ask, marker-only turns leave the card and nothing else.

import { chatMessages, createDb, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { persistAssistantTurnWithAsk } from '../persistTurnWithAsk'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const TEAM = 'team-1'
const AGENT = 'lead-1'

function entries(): { kind: string; text: string }[] {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionKey, `agent:${AGENT}:team:${TEAM}`))
    .all()
    .map((r) => JSON.parse(r.data) as { kind: string; text: string })
}

describe('persistAssistantTurnWithAsk', () => {
  it('persists an ordinary reply untouched, no card', () => {
    expect(
      persistAssistantTurnWithAsk(db, { teamId: TEAM, agentId: AGENT, text: 'plain answer' }),
    ).toBe(true)
    const all = entries()
    expect(all).toHaveLength(1)
    expect(all[0]!.text).toBe('plain answer')
  })

  it('strips the marker from the reply and posts exactly one card', () => {
    persistAssistantTurnWithAsk(db, {
      teamId: TEAM,
      agentId: AGENT,
      text: 'I need Linear for that.\n[[connect:linear]]',
    })
    const all = entries()
    expect(all).toHaveLength(2)
    const assistant = all.find((e) => e.kind === 'assistant')!
    const meta = all.find((e) => e.kind === 'meta')!
    expect(assistant.text).toBe('I need Linear for that.')
    expect(assistant.text).not.toContain('[[connect:')
    expect(meta.text).toContain('clawboo:connect-ask linear')
  })

  it('a marker-only turn returns false and leaves only the card', () => {
    const ok = persistAssistantTurnWithAsk(db, {
      teamId: TEAM,
      agentId: AGENT,
      text: '[[connect:linear]]',
    })
    // false is the clearing-delta signal: the streamed remnant is removed and
    // the reader is left with the card alone.
    expect(ok).toBe(false)
    const all = entries()
    expect(all).toHaveLength(1)
    expect(all[0]!.kind).toBe('meta')
  })

  it('the same ask twice is one card, not two', () => {
    const text = 'Still need it.\n[[connect:linear]]'
    persistAssistantTurnWithAsk(db, { teamId: TEAM, agentId: AGENT, text })
    persistAssistantTurnWithAsk(db, { teamId: TEAM, agentId: AGENT, text })
    const metas = entries().filter((e) => e.kind === 'meta')
    expect(metas).toHaveLength(1)
  })

  it('a different set of slugs is a different offer and gets its own card', () => {
    persistAssistantTurnWithAsk(db, { teamId: TEAM, agentId: AGENT, text: 'a [[connect:linear]]' })
    persistAssistantTurnWithAsk(db, {
      teamId: TEAM,
      agentId: AGENT,
      text: 'b [[connect:linear]] [[connect:notion]]',
    })
    const metas = entries().filter((e) => e.kind === 'meta')
    expect(metas).toHaveLength(2)
  })
})
