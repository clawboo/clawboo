// persistTeamChatEntry — the single team-chat writer. Asserts the convergence
// guarantees a thin client depends on: the row is keyed `agent:<id>:team:<teamId>`
// (the exact key /api/chat-history + GroupChatPanel read) and `data` is a full
// TranscriptEntry; idempotency via a stable entryId; the write-time control-token
// drop is assistant-role-only; and the server sequenceKey is strictly increasing.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chatMessages, createDb, type ClawbooDb } from '@clawboo/db'
import type { TranscriptEntry } from '@clawboo/protocol'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getDbPath } from '../../db'
import { persistTeamChatEntry } from '../persistTeamChatEntry'

const TEAM = 'team-1'

describe('persistTeamChatEntry (the single team-chat writer)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-persist-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function rowsFor(agentId: string): TranscriptEntry[] {
    const sk = buildTeamSessionKey(agentId, TEAM)
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sk))
      .all()
      .map((r) => JSON.parse(r.data as string) as TranscriptEntry)
  }

  it('round-trips a TranscriptEntry under the team-scoped session key', () => {
    persistTeamChatEntry(db, {
      teamId: TEAM,
      agentId: 'a1',
      text: 'Here is my analysis of the plan.',
      role: 'assistant',
      kind: 'assistant',
    })
    const entries = rowsFor('a1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      role: 'assistant',
      kind: 'assistant',
      text: 'Here is my analysis of the plan.',
      sessionKey: buildTeamSessionKey('a1', TEAM),
      confirmed: true,
    })
    expect(typeof entries[0]!.sequenceKey).toBe('number')
    expect(typeof entries[0]!.entryId).toBe('string')
  })

  it('is idempotent across a re-drive with the same entryId (ON CONFLICT DO NOTHING)', () => {
    const input = {
      teamId: TEAM,
      agentId: 'a2',
      text: 'first',
      role: 'assistant' as const,
      kind: 'assistant' as const,
      entryId: 'stable-entry-id',
    }
    persistTeamChatEntry(db, input)
    persistTeamChatEntry(db, { ...input, text: 'a re-drive of the same logical turn' })
    const entries = rowsFor('a2')
    expect(entries).toHaveLength(1)
    // The first write wins (the second is a no-op).
    expect(entries[0]!.text).toBe('first')
  })

  describe('write-time control-token drop (assistant-role only)', () => {
    it('drops an assistant turn whose body is a control token / short refusal', () => {
      persistTeamChatEntry(db, { teamId: TEAM, agentId: 'drop', text: '__skipped__', role: 'assistant', kind: 'assistant' })
      persistTeamChatEntry(db, { teamId: TEAM, agentId: 'drop', text: 'NO_REPLY', role: 'assistant', kind: 'assistant' })
      persistTeamChatEntry(db, { teamId: TEAM, agentId: 'drop', text: 'Nope.', role: 'assistant', kind: 'assistant' })
      expect(rowsFor('drop')).toHaveLength(0)
    })

    it('keeps a substantive assistant turn', () => {
      persistTeamChatEntry(db, {
        teamId: TEAM,
        agentId: 'keep',
        text: 'I will look into that and respond with a full breakdown shortly.',
        role: 'assistant',
        kind: 'assistant',
      })
      expect(rowsFor('keep')).toHaveLength(1)
    })

    it('does NOT drop the SAME text when role is user or meta (role gate)', () => {
      // A `[Task Update]` meta + a user message that happens to look like a refusal
      // must never be dropped — only assistant turns are filtered.
      persistTeamChatEntry(db, { teamId: TEAM, agentId: 'u', text: 'Nope.', role: 'user', kind: 'user' })
      persistTeamChatEntry(db, { teamId: TEAM, agentId: 'm', text: '__skipped__', role: 'system', kind: 'meta' })
      expect(rowsFor('u')).toHaveLength(1)
      expect(rowsFor('m')).toHaveLength(1)
    })
  })

  it('assigns a strictly-increasing server sequenceKey (the merged-sort tiebreaker)', () => {
    persistTeamChatEntry(db, { teamId: TEAM, agentId: 'seq', text: 'first', role: 'user', kind: 'user' })
    persistTeamChatEntry(db, { teamId: TEAM, agentId: 'seq', text: 'second', role: 'assistant', kind: 'assistant' })
    const entries = rowsFor('seq').sort((a, b) => a.sequenceKey - b.sequenceKey)
    expect(entries).toHaveLength(2)
    expect(entries[1]!.sequenceKey).toBeGreaterThan(entries[0]!.sequenceKey)
  })

  it('drops empty / whitespace-only text', () => {
    persistTeamChatEntry(db, { teamId: TEAM, agentId: 'empty', text: '   ', role: 'assistant', kind: 'assistant' })
    expect(rowsFor('empty')).toHaveLength(0)
  })
})
