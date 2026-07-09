// teamChatStream — the live-chat SSE route's substantive read path (the SSE
// scaffolding itself is a faithful clone of obs/stream, verified manually). Asserts
// `resolveTeamSessionKeys` maps a team's members to their team-keys, and that the
// resolve → listChatMessagesSince flow emits new team rows in id order from a cursor
// while excluding other sessions' rows.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, chatMessages, createDb, listChatMessagesSince, teams, type ClawbooDb } from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'

import { resolveTeamSessionKeys } from '../teamChatStream'

let dir: string
let db: ClawbooDb
let seq = 0

function seedTeam(id: string): void {
  db.insert(teams)
    .values({ id, name: id, icon: '🚀', color: '#fff', createdAt: 0, updatedAt: 0 })
    .run()
}
function seedAgent(id: string, teamId: string): void {
  db.insert(agents)
    .values({ id, name: id, gatewayId: id, teamId, createdAt: 0, updatedAt: 0 })
    .run()
}
function insertChat(sessionKey: string, text: string): number {
  seq += 1
  const row = db
    .insert(chatMessages)
    .values({
      sessionKey,
      gatewayUrl: '',
      entryId: `e${seq}`,
      timestampMs: seq,
      data: JSON.stringify({ entryId: `e${seq}`, sessionKey, text }),
    })
    .returning({ id: chatMessages.id })
    .get() as { id: number }
  return row.id
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-team-stream-'))
  db = createDb(path.join(dir, 'test.db'))
  seq = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('teamChatStream read path', () => {
  it('resolveTeamSessionKeys → the team members’ team-keys, excluding other teams', () => {
    seedTeam('T')
    seedTeam('OTHER')
    seedAgent('a1', 'T')
    seedAgent('a2', 'T')
    seedAgent('a3', 'OTHER')

    const keys = resolveTeamSessionKeys(db, 'T')
    expect([...keys].sort()).toEqual(
      [buildTeamSessionKey('a1', 'T'), buildTeamSessionKey('a2', 'T')].sort(),
    )
    // an agent in another team is not in the set
    expect(keys).not.toContain(buildTeamSessionKey('a3', 'OTHER'))
  })

  it('the resolve → tail flow emits new team rows in id order and advances the cursor', () => {
    seedTeam('T')
    seedAgent('a1', 'T')
    seedAgent('a2', 'T')
    const keys = resolveTeamSessionKeys(db, 'T')

    const first = insertChat(buildTeamSessionKey('a1', 'T'), 'user msg')
    insertChat('agent:a1:native', 'noise — 1:1, not in the team set')
    const second = insertChat(buildTeamSessionKey('a2', 'T'), 'delegate reply')

    const all = listChatMessagesSince(db, { sessionKeys: keys, afterId: 0 })
    expect(all.map((r) => r.id)).toEqual([first, second])

    // Resume from the first row's id → only the tail.
    const tail = listChatMessagesSince(db, { sessionKeys: keys, afterId: first })
    expect(tail.map((r) => r.id)).toEqual([second])
  })

  it('resolveTeamSessionKeys returns [] for a team with no agents (stream still opens, tails nothing)', () => {
    seedTeam('EMPTY')
    expect(resolveTeamSessionKeys(db, 'EMPTY')).toEqual([])
    expect(listChatMessagesSince(db, { sessionKeys: [], afterId: 0 })).toEqual([])
  })
})
