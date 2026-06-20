// The native runtime's in-process TeamChat attach (the fifth attach point — the
// peer-class runtime posts/subscribes via the in-memory bridge, no socket).

import { createDb, readRoom, resolveRoomForTeam, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { connectMcpBridge } from '../mcpBridge'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

describe('native MCP bridge — TeamChat', () => {
  it('exposes team_chat_post/subscribe bound to the native agent identity', async () => {
    const bridge = await connectMcpBridge({
      dbPath: ':memory:',
      agentId: 'boo-native',
      enable: { tasks: false, memory: false, tools: false, teamchat: true },
      memoryScope: { teamId: 'tm1' },
      makeDb: () => db,
    })
    expect(bridge).not.toBeNull()
    const names = (await bridge!.listTools()).map((t) => t.name)
    expect(names).toContain('team_chat_post')
    expect(names).toContain('team_chat_subscribe')

    // A post lands authored by the BOUND identity (anti-spoof), not the args.
    const out = await bridge!.callTool('team_chat_post', {
      text: 'native here',
      authorAgentId: 'spoofed',
    })
    expect(out.isError).toBe(false)
    const room = readRoom(db, { roomId: resolveRoomForTeam('tm1') })
    expect(room).toHaveLength(1)
    expect(room[0]!.authorAgentId).toBe('boo-native')
    expect(room[0]!.body).toBe('native here')
    await bridge!.close()
  })

  it('does not attach teamchat without an agentId + team (needs a bound identity)', async () => {
    const bridge = await connectMcpBridge({
      dbPath: ':memory:',
      enable: { tasks: false, memory: false, tools: false, teamchat: true },
      makeDb: () => db,
    })
    // No agentId / no team → nothing to attach → null bridge.
    expect(bridge).toBeNull()
  })
})
