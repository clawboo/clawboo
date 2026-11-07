// The runner starts nothing for a team that is not on the board, so a test that runs a
// task on a team needs the team's row. Only test code uses this.

import { teams, type ClawbooDb } from '@clawboo/db'
import { expect } from 'vitest'

import { getDb, getDbPath } from '../db'

/** Add a team's row to this database. */
export function seedTeamRow(db: ClawbooDb, teamId = 'team-1'): void {
  const now = Date.now()
  db.insert(teams)
    .values({ id: teamId, name: teamId, icon: 'x', color: '#000', createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run()
}

/** The same in the server's database, once it is proven to be the test's sandbox. */
export function seedSandboxTeam(home: string, teamId = 'team-1'): void {
  expect(getDbPath().startsWith(home)).toBe(true)
  seedTeamRow(getDb(), teamId)
}
