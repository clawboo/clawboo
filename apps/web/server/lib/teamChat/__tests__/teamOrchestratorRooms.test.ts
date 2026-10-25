// A chat room's orchestrator: its roster is the room's members plus Boo Zero,
// never the rest of the team. A message routes only to someone in the room (an
// explicit target or an @mention of an outsider is ignored), the turn runs on the
// room's session key, and the transcript lands under it. The team's own group
// chat is untouched by any of it.
//
// The run primitive is faked (a file-global vi.mock, hence its own file) so the
// test sees exactly what the orchestrator hands it.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, chatMessages, createRoom, teams } from '@clawboo/db'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { TurnOrigin } from '@clawboo/team-orchestration'

const delivered: Array<{ sessionKey: string; agentId: string; task: string; origin: TurnOrigin }> =
  []
const deliverRooms: Array<string | null> = []

vi.mock('../serverDeliver', () => ({
  createServerDeliver: (deps: { chatRoomId?: string | null }) => {
    deliverRooms.push(deps.chatRoomId ?? null)
    return async (sessionKey: string, agentId: string, task: string, origin: TurnOrigin) => {
      delivered.push({ sessionKey, agentId, task, origin })
    }
  },
}))

const { getDb, resetDb } = await import('../../db')
const { getTeamOrchestrator, hasTeamOrchestrator, resetTeamOrchestrators, retireRoomOrchestrator } =
  await import('../teamOrchestrator')

function transcript(): TranscriptEntry[] {
  return getDb()
    .select()
    .from(chatMessages)
    .all()
    .map((row) => JSON.parse(row.data) as TranscriptEntry)
}

describe('team chat rooms in the orchestrator', () => {
  let home: string
  let prevHome: string | undefined
  let roomId: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-rooms-orch-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    delivered.length = 0
    deliverRooms.length = 0
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team',
        icon: 'T',
        color: '#e94560',
        leaderAgentId: 'lead',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const [id, name, offset] of [
      ['lead', 'Lead', 0],
      ['bea', 'Bea', 1],
      ['cy', 'Cy', 2],
    ] as const) {
      db.insert(agents)
        .values({
          id,
          name,
          gatewayId: id,
          sourceId: 'clawboo-native',
          runtime: 'clawboo-native',
          teamId: 'T',
          createdAt: now + offset,
          updatedAt: now + offset,
        })
        .run()
    }
    // A room without the team's lead: Bea and Cy only.
    roomId = createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['bea', 'cy'] }).id
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it("routes an unaddressed message to the room's first member when the team lead is not in it", async () => {
    const result = await getTeamOrchestrator('T', { roomId }).enqueueUserMessage({
      stimulus: 'Sketch the onboarding flow.',
    })
    expect(result).toEqual({ ok: true, targetAgentId: 'bea' })
    expect(delivered).toEqual([
      {
        sessionKey: `agent:bea:team:T:room:${roomId}`,
        agentId: 'bea',
        task: 'Sketch the onboarding flow.',
        origin: { kind: 'human' },
      },
    ])
    expect(deliverRooms).toEqual([roomId])
    expect(transcript()[0]).toMatchObject({
      role: 'user',
      sessionKey: `agent:bea:team:T:room:${roomId}`,
    })
  })

  it('ignores an explicit target and an @mention outside the room', async () => {
    const orch = getTeamOrchestrator('T', { roomId })
    await orch.enqueueUserMessage({ stimulus: 'hello', targetAgentId: 'lead' })
    await orch.enqueueUserMessage({ stimulus: '@Lead take this' })
    expect(delivered.map((d) => d.agentId)).toEqual(['bea', 'bea'])
    // A member is still addressable by name.
    await orch.enqueueUserMessage({ stimulus: '@Cy take this' })
    expect(delivered[2]?.agentId).toBe('cy')
    expect(delivered[2]?.sessionKey).toBe(`agent:cy:team:T:room:${roomId}`)
  })

  it("leaves the team's own group chat exactly as it was", async () => {
    const result = await getTeamOrchestrator('T').enqueueUserMessage({ stimulus: 'hi team' })
    expect(result).toEqual({ ok: true, targetAgentId: 'lead' })
    expect(delivered[0]?.sessionKey).toBe('agent:lead:team:T')
    // A different instance from the room's.
    getTeamOrchestrator('T', { roomId })
    expect(deliverRooms).toEqual([null, roomId])
    expect(hasTeamOrchestrator('T')).toBe(true)
    expect(hasTeamOrchestrator('T', roomId)).toBe(true)
  })

  it('a room whose members all left takes no message', async () => {
    const db = getDb()
    db.update(agents).set({ teamId: null }).run()
    const result = await getTeamOrchestrator('T', { roomId }).enqueueUserMessage({
      stimulus: 'anyone?',
    })
    expect(result).toEqual({ ok: false, error: 'The room has no active members.' })
    expect(delivered).toHaveLength(0)
  })

  it("retiring a room drops only that room's instance", () => {
    getTeamOrchestrator('T')
    getTeamOrchestrator('T', { roomId })
    retireRoomOrchestrator('T', roomId)
    expect(hasTeamOrchestrator('T', roomId)).toBe(false)
    expect(hasTeamOrchestrator('T')).toBe(true)
  })
})
