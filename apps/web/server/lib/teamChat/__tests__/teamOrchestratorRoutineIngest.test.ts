// A scheduled routine posting into team chat goes through the same ingest as a
// typed message, with two differences the rest of the product relies on: the
// transcript entry names the routine (so the chat shows who posted it), and the
// turn is stamped with a `schedule` origin (so the lead is told nobody may be
// watching). The ingest also reports what happened, which is what a routine
// records as its outcome.
//
// The run primitive is faked (a file-global vi.mock, hence its own file) so the
// test sees exactly what the orchestrator hands it, with no adapter involved.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, chatMessages, teams } from '@clawboo/db'
import type { TranscriptEntry } from '@clawboo/protocol'
import type { TurnOrigin } from '@clawboo/team-orchestration'

const delivered: Array<{ sessionKey: string; agentId: string; task: string; origin: TurnOrigin }> =
  []
let failNextDelivery: Error | null = null

vi.mock('../serverDeliver', () => ({
  createServerDeliver: () => {
    return async (sessionKey: string, agentId: string, task: string, origin: TurnOrigin) => {
      if (failNextDelivery) {
        const err = failNextDelivery
        failNextDelivery = null
        throw err
      }
      delivered.push({ sessionKey, agentId, task, origin })
    }
  },
}))

const { getDb, resetDb } = await import('../../db')
const { getTeamOrchestrator, resetTeamOrchestrators } = await import('../teamOrchestrator')

function transcript(): TranscriptEntry[] {
  return getDb()
    .select()
    .from(chatMessages)
    .all()
    .map((row) => JSON.parse(row.data) as TranscriptEntry)
}

describe('team chat ingest from a routine', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-routine-ingest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    delivered.length = 0
    failNextDelivery = null
    const db = getDb()
    const now = Date.now()
    for (const id of ['T', 'EMPTY']) {
      db.insert(teams)
        .values({
          id,
          name: `Team ${id}`,
          icon: 'T',
          color: '#e94560',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        sourceId: 'clawboo-native',
        runtime: 'clawboo-native',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('posts the message as the routine and runs the lead with a schedule origin', async () => {
    const result = await getTeamOrchestrator('T').enqueueUserMessage({
      stimulus: 'Summarize what shipped yesterday.',
      routine: { id: 'r1', name: 'Morning briefing' },
    })
    expect(result).toEqual({ ok: true, targetAgentId: 'lead' })
    expect(delivered).toEqual([
      {
        sessionKey: 'agent:lead:team:T',
        agentId: 'lead',
        task: 'Summarize what shipped yesterday.',
        origin: { kind: 'schedule', routineName: 'Morning briefing' },
      },
    ])
    const [entry] = transcript()
    expect(entry).toMatchObject({
      role: 'user',
      kind: 'user',
      text: 'Summarize what shipped yesterday.',
      sessionKey: 'agent:lead:team:T',
      origin: { kind: 'routine', routineId: 'r1', routineName: 'Morning briefing' },
    })
  })

  it('a typed message keeps the human origin and carries no routine', async () => {
    const result = await getTeamOrchestrator('T').enqueueUserMessage({ stimulus: 'hello' })
    expect(result).toEqual({ ok: true, targetAgentId: 'lead' })
    expect(delivered[0]?.origin).toEqual({ kind: 'human' })
    expect(transcript()[0]).not.toHaveProperty('origin')
  })

  it('a delivery that fails is reported back and noted in the chat', async () => {
    failNextDelivery = new Error("runtime 'mystery' is not server-orchestrated yet")
    const result = await getTeamOrchestrator('T').enqueueUserMessage({
      stimulus: 'Do the thing.',
      routine: { id: 'r1', name: 'Chore' },
    })
    expect(result).toEqual({
      ok: false,
      error: "runtime 'mystery' is not server-orchestrated yet",
    })
    const entries = transcript()
    expect(entries.map((e) => e.role)).toEqual(['user', 'system'])
    expect(entries[1]?.text).toContain('Could not reach the team')
  })

  it('a team with nobody on it takes no message', async () => {
    const result = await getTeamOrchestrator('EMPTY').enqueueUserMessage({
      stimulus: 'Anyone?',
      routine: { id: 'r2', name: 'Ping' },
    })
    expect(result).toEqual({ ok: false, error: 'The team has no active members.' })
    expect(delivered).toHaveLength(0)
    expect(transcript()).toHaveLength(0)
  })
})
