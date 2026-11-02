// Team chat's ready list leaves out the tasks the task runner reruns. Fired from
// team chat, a task the runner ran would rerun as a chat turn, with no worktree
// and no check; the runner's own pump re-fires it instead (lib/runnerRerun).

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  createDb,
  createTask,
  setTaskRunnerInputs,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createServerBoardClient } from '../serverBoardClient'

const TEAM = 't1'
let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
  const now = Date.now()
  db.insert(teams)
    .values({ id: TEAM, name: 'Team', icon: 'T', color: '#123456', createdAt: now, updatedAt: now })
    .run()
  for (const [id, runtime] of [
    ['builder', 'claude-code'],
    ['oc', 'openclaw'],
  ] as const) {
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        runtime,
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
})

function boundTask(title: string, agentId: string, ranOnRunner: boolean): string {
  const t = createTask(db, {
    title,
    teamId: TEAM,
    status: 'todo',
    sourceDelegationId: encodeHumanAssignment(agentId, title),
  })
  if (ranOnRunner) {
    setTaskRunnerInputs(db, t.id, {
      runtime: 'claude-code',
      assigneeAgentId: 'builder',
      repoPath: '/repo',
      kind: 'code',
      model: null,
    })
  }
  return t.id
}

describe('server board client: ready tasks', () => {
  it('leaves out a task the runner ran when its agent is one the runner runs', async () => {
    const runner = boundTask('runner', 'builder', true)
    const chat = boundTask('chat', 'builder', false)
    // Bound to an OpenClaw agent: the runner cannot run it, so team chat does.
    const openclaw = boundTask('openclaw', 'oc', true)
    const ready = await createServerBoardClient(db).getReadyTasks(TEAM)
    const ids = ready.map((t) => t.id)
    expect(ids).not.toContain(runner)
    expect(ids).toEqual(expect.arrayContaining([chat, openclaw]))
  })
})
