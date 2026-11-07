// A native agent's one-to-one chat reaches the Tasks tools in-process, with no URL to
// sign. The chat mark has to get there all the same, or a native Boo Zero keeps every
// write on the board that the fence on its hand-off tags keeps it from.

import { createDb, createTask, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { connectMcpBridge } from '../mcpBridge'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
  createTask(db, { title: 'in my team', teamId: 'A' })
  createTask(db, { title: 'in their team', teamId: 'B' })
})

const bridgeFor = async (chatRunTeamId: string | null) => {
  const bridge = await connectMcpBridge({
    db,
    agentId: 'coder',
    enable: { tasks: true, memory: false, tools: false },
    chatRun: true,
    chatRunTeamId,
  })
  if (!bridge) throw new Error('no bridge')
  return bridge
}

describe('Tasks tools on a native one-to-one chat', () => {
  it('are the reads and add_comment', async () => {
    const bridge = await bridgeFor(null)
    try {
      expect((await bridge.listTools()).map((t) => t.name)).toEqual([
        'add_comment',
        'get_task',
        'list_tasks',
      ])
    } finally {
      await bridge.close()
    }
  })

  it('read the agent’s own team when it is on one', async () => {
    const bridge = await bridgeFor('A')
    try {
      const { output } = await bridge.callTool('list_tasks', {})
      expect(output).toContain('in my team')
      expect(output).not.toContain('in their team')
    } finally {
      await bridge.close()
    }
  })

  it('read across teams for a teamless Boo Zero, which needs the whole board to answer', async () => {
    const bridge = await bridgeFor(null)
    try {
      const { output } = await bridge.callTool('list_tasks', {})
      expect(output).toContain('in my team')
      expect(output).toContain('in their team')
    } finally {
      await bridge.close()
    }
  })
})
