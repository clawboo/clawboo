// The agent user pool's records: users to live agents oldest first, kept for
// life, wiped before reuse; the same for team groups.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  agentOsUserOf,
  assignAgentOsUsers,
  assignTeamOsGroups,
  finishAgentOsUserScrub,
  finishTeamOsGroupScrub,
  listAgentOsUsers,
  syncAgentOsUsers,
  syncTeamOsGroups,
  teamOsGroupOf,
} from '../agentOsUsers'
import { createDb, type ClawbooDb } from '../db'
import { agents, teams } from '../schema'
import { eq } from 'drizzle-orm'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

function addAgent(
  id: string,
  createdAt: number,
  extra: Partial<typeof agents.$inferInsert> = {},
): void {
  db.insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      runtime: 'codex',
      createdAt,
      updatedAt: createdAt,
      ...extra,
    })
    .run()
}

function addTeam(id: string, createdAt: number): void {
  db.insert(teams)
    .values({ id, name: id, icon: 'x', color: '#000', createdAt, updatedAt: createdAt })
    .run()
}

const pool = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `clawboo-a${i + 1}`, id: 20001 + i, order: i }))

describe('agent users', () => {
  it('hands users to live agents oldest first, and keeps them', () => {
    syncAgentOsUsers(db, pool(3))
    addAgent('newer', 200)
    addAgent('older', 100)
    const first = assignAgentOsUsers(db)
    expect(first.assigned).toEqual([
      { ownerId: 'older', name: 'clawboo-a1' },
      { ownerId: 'newer', name: 'clawboo-a2' },
    ])
    expect(first.waiting).toEqual([])
    // A second pass changes nothing: an agent keeps its user.
    expect(assignAgentOsUsers(db).assigned).toEqual([])
    expect(agentOsUserOf(db, 'older')?.userName).toBe('clawboo-a1')
  })

  it('leaves the newest agents waiting when the pool runs short, and serves them in order later', () => {
    syncAgentOsUsers(db, pool(1))
    addAgent('a', 1)
    addAgent('b', 2)
    addAgent('c', 3)
    const res = assignAgentOsUsers(db)
    expect(res.assigned.map((a) => a.ownerId)).toEqual(['a'])
    expect(res.waiting).toEqual(['b', 'c'])
    syncAgentOsUsers(db, pool(2))
    expect(assignAgentOsUsers(db).assigned).toEqual([{ ownerId: 'b', name: 'clawboo-a2' }])
    expect(assignAgentOsUsers(db).waiting).toEqual(['c'])
  })

  it('gives no user to people, archived agents or excluded runtimes', () => {
    syncAgentOsUsers(db, pool(4))
    addAgent('person', 1, { participantKind: 'human' })
    addAgent('archived', 2, { archivedAt: 5 })
    addAgent('claw', 3, { runtime: 'openclaw' })
    addAgent('worker', 4)
    const res = assignAgentOsUsers(db, { excludeRuntimes: ['openclaw'] })
    expect(res.assigned.map((a) => a.ownerId)).toEqual(['worker'])
  })

  it('an archived agent keeps the user it had', () => {
    syncAgentOsUsers(db, pool(1))
    addAgent('a', 1)
    assignAgentOsUsers(db)
    db.update(agents).set({ archivedAt: 9 }).where(eq(agents.id, 'a')).run()
    addAgent('b', 2)
    const res = assignAgentOsUsers(db)
    expect(res.assigned).toEqual([])
    expect(res.waiting).toEqual(['b'])
    expect(agentOsUserOf(db, 'a')?.userName).toBe('clawboo-a1')
  })

  it("marks a deleted agent's user for wiping, and frees it only once wiped", () => {
    syncAgentOsUsers(db, pool(1))
    addAgent('gone', 1)
    assignAgentOsUsers(db)
    db.delete(agents).where(eq(agents.id, 'gone')).run()
    addAgent('next', 2)
    const res = assignAgentOsUsers(db)
    expect(res.scrubbing).toEqual([{ name: 'clawboo-a1', ownerId: 'gone' }])
    expect(res.assigned).toEqual([])
    expect(res.waiting).toEqual(['next'])
    expect(finishAgentOsUserScrub(db, 'clawboo-a1')).toBe(true)
    // Twice is a no-op: only a user being wiped is freed.
    expect(finishAgentOsUserScrub(db, 'clawboo-a1')).toBe(false)
    expect(assignAgentOsUsers(db).assigned).toEqual([{ ownerId: 'next', name: 'clawboo-a1' }])
  })

  it('a user the setting drops keeps its agent but goes to nobody new', () => {
    syncAgentOsUsers(db, pool(2))
    addAgent('a', 1)
    assignAgentOsUsers(db)
    syncAgentOsUsers(db, [{ name: 'clawboo-a2', id: 20002, order: 0 }])
    const rows = listAgentOsUsers(db)
    expect(rows.find((r) => r.userName === 'clawboo-a1')).toMatchObject({
      inPool: 0,
      state: 'assigned',
      agentId: 'a',
    })
    addAgent('b', 2)
    expect(assignAgentOsUsers(db).assigned).toEqual([{ ownerId: 'b', name: 'clawboo-a2' }])
    addAgent('c', 3)
    expect(assignAgentOsUsers(db).waiting).toEqual(['c'])
  })

  it('an empty setting takes every user out of the pool', () => {
    syncAgentOsUsers(db, pool(2))
    syncAgentOsUsers(db, [])
    expect(listAgentOsUsers(db).every((r) => r.inPool === 0)).toBe(true)
  })
})

describe('team groups', () => {
  const groups = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `clawboo-t${i + 1}`, id: 21001 + i, order: i }))

  it('hands groups to live teams oldest first, and wipes before reuse', () => {
    syncTeamOsGroups(db, groups(1))
    addTeam('t-old', 1)
    addTeam('t-new', 2)
    const res = assignTeamOsGroups(db)
    expect(res.assigned).toEqual([{ ownerId: 't-old', name: 'clawboo-t1' }])
    expect(res.waiting).toEqual(['t-new'])
    expect(teamOsGroupOf(db, 't-old')?.groupName).toBe('clawboo-t1')
    db.delete(teams).where(eq(teams.id, 't-old')).run()
    expect(assignTeamOsGroups(db).scrubbing).toEqual([{ name: 'clawboo-t1', ownerId: 't-old' }])
    expect(finishTeamOsGroupScrub(db, 'clawboo-t1')).toBe(true)
    expect(assignTeamOsGroups(db).assigned).toEqual([{ ownerId: 't-new', name: 'clawboo-t1' }])
  })
})
