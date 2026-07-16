// TeamChat MCP contract test. Boots bound TeamChat servers over the in-memory
// transport and drives them with a real MCP Client — proving every runtime can
// post + subscribe as a named peer, the isUser=false evidence tagging, the
// per-(room,author) echo guard, and the anti-spoof identity binding.

import { createDb, readRoom, resolveRoomForTeam, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { createTeamChatServer, type TeamChatBoundIdentity } from '../teamchat/server'
import { callText, connectInMemory, listToolNames } from '../testing'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const ident = (agentId: string, teamId: string): TeamChatBoundIdentity => ({
  agentId,
  teamId,
  roomId: resolveRoomForTeam(teamId),
})

describe('TeamChat MCP (quartet)', () => {
  it('a peer posts and another peer receives it wrapped as isUser=false evidence', async () => {
    const leader = await connectInMemory(
      createTeamChatServer(db, { boundIdentity: ident('leader', 'tm1') }),
    )
    const worker = await connectInMemory(
      createTeamChatServer(db, { boundIdentity: ident('worker', 'tm1') }),
    )

    const posted = await callText(leader, 'team_chat_post', { text: 'kick off the build' })
    expect(posted.isError).toBe(false)
    expect(JSON.parse(posted.text).posted.authorAgentId).toBe('leader')

    const sub = await callText(worker, 'team_chat_subscribe', {})
    const { posts } = JSON.parse(sub.text) as {
      posts: { authorAgentId: string; wrapped: string }[]
    }
    expect(posts).toHaveLength(1)
    expect(posts[0]!.authorAgentId).toBe('leader')
    // The load-bearing safety substring: a peer's post is non-user evidence.
    expect(posts[0]!.wrapped).toContain('isUser=false')
    expect(posts[0]!.wrapped).toContain('[Inter-session message')
    expect(posts[0]!.wrapped).toContain('kick off the build')
  })

  it('the echo guard: a poster never receives its OWN posts back', async () => {
    const worker = await connectInMemory(
      createTeamChatServer(db, { boundIdentity: ident('worker', 'tm1') }),
    )
    await callText(worker, 'team_chat_post', { text: 'on it' })
    const sub = await callText(worker, 'team_chat_subscribe', {})
    const { posts } = JSON.parse(sub.text) as { posts: unknown[] }
    expect(posts).toHaveLength(0)
  })

  it('authorAgentId comes from the connection binding — args cannot spoof a peer', async () => {
    const worker = await connectInMemory(
      createTeamChatServer(db, { boundIdentity: ident('worker', 'tm1') }),
    )
    // The model tries to post AS the leader by passing authorAgentId in args.
    await callText(worker, 'team_chat_post', {
      text: 'sneaky',
      authorAgentId: 'leader',
      roomId: 'team:evil',
    })
    const rows = readRoom(db, { roomId: resolveRoomForTeam('tm1') })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.authorAgentId).toBe('worker') // binding wins, not the spoofed arg
    expect(rows[0]!.roomId).toBe('team:tm1') // bound room wins, not the spoofed roomId
  })

  it('subscribe honours the sinceSeq cursor', async () => {
    const a = await connectInMemory(createTeamChatServer(db, { boundIdentity: ident('a', 'tm1') }))
    const b = await connectInMemory(createTeamChatServer(db, { boundIdentity: ident('b', 'tm1') }))
    await callText(a, 'team_chat_post', { text: 'one' })
    await callText(a, 'team_chat_post', { text: 'two' })
    const first = await callText(b, 'team_chat_subscribe', {})
    const firstParsed = JSON.parse(first.text) as { posts: { wrapped: string }[]; nextSeq: number }
    expect(firstParsed.posts).toHaveLength(2)
    expect(firstParsed.nextSeq).toBe(2)
    await callText(a, 'team_chat_post', { text: 'three' })
    const tail = await callText(b, 'team_chat_subscribe', { sinceSeq: firstParsed.nextSeq })
    const tailParsed = JSON.parse(tail.text) as { posts: { wrapped: string }[] }
    expect(tailParsed.posts).toHaveLength(1)
    expect(tailParsed.posts[0]!.wrapped).toContain('three')
  })

  it('subscribe advances nextSeq to the room head past the caller’s OWN trailing posts (no stall)', async () => {
    const a = await connectInMemory(createTeamChatServer(db, { boundIdentity: ident('a', 'tm1') }))
    const b = await connectInMemory(createTeamChatServer(db, { boundIdentity: ident('b', 'tm1') }))
    await callText(b, 'team_chat_post', { text: 'from b' }) // seq 1 (a teammate)
    await callText(a, 'team_chat_post', { text: 'a-one' }) // seq 2 (the caller)
    await callText(a, 'team_chat_post', { text: 'a-two' }) // seq 3 (the caller, latest)
    // 'a' subscribes: its own posts (2,3) are excluded so only b's post is
    // delivered — but the cursor must advance to the TRUE head (3), not stall at
    // the last DELIVERED seq (1), else a re-poll keeps re-reading the same row.
    const sub = await callText(a, 'team_chat_subscribe', {})
    const parsed = JSON.parse(sub.text) as { posts: { wrapped: string }[]; nextSeq: number }
    expect(parsed.posts).toHaveLength(1)
    expect(parsed.posts[0]!.wrapped).toContain('from b')
    expect(parsed.nextSeq).toBe(3)
  })

  it('rejects an empty post', async () => {
    const a = await connectInMemory(createTeamChatServer(db, { boundIdentity: ident('a', 'tm1') }))
    const res = await callText(a, 'team_chat_post', { text: '   ' })
    expect(res.isError).toBe(true)
  })

  it('fires the onPost hook for obs', async () => {
    const seen: string[] = []
    const a = await connectInMemory(
      createTeamChatServer(db, {
        boundIdentity: ident('a', 'tm1'),
        onPost: (p) => seen.push(p.body),
      }),
    )
    await callText(a, 'team_chat_post', { text: 'observed' })
    expect(seen).toEqual(['observed'])
  })

  // ── team_delegate — the coding-runtime delegation SIGNAL tool ──────────────
  // Exposed ONLY on an orchestrator-driven session (`bound.delegate`, the
  // `delegate=1` attach param serverDeliver writes). A merely team-BOUND session
  // (an executorRunner board-task run) must not see it — nothing observes
  // delegation there, so the model would "delegate" into a silent no-op (the
  // exact failure the native driver's isTeamSessionKey gating avoids).
  describe('team_delegate', () => {
    it('is EXPOSED only on an orchestrator-driven session (bound + delegate)', async () => {
      const orchestrated = await connectInMemory(
        createTeamChatServer(db, { boundIdentity: { ...ident('leader', 'tm1'), delegate: true } }),
      )
      expect(await listToolNames(orchestrated)).toContain('team_delegate')

      // Bound-but-not-orchestrated (e.g. an executorRunner board-task run): hidden.
      const scopedOnly = await connectInMemory(
        createTeamChatServer(db, { boundIdentity: ident('leader', 'tm1') }),
      )
      expect(await listToolNames(scopedOnly)).not.toContain('team_delegate')

      // Unbound (raw stdio bin / external attach): hidden.
      const unbound = await connectInMemory(createTeamChatServer(db, {}))
      expect(await listToolNames(unbound)).not.toContain('team_delegate')
    })

    it('is signal-only: ACKs without touching the room (the engine owns the board)', async () => {
      const leader = await connectInMemory(
        createTeamChatServer(db, { boundIdentity: { ...ident('leader', 'tm1'), delegate: true } }),
      )
      const res = await callText(leader, 'team_delegate', {
        assignee: 'Coder',
        task: 'write the parser',
      })
      expect(res.isError).toBe(false)
      expect(res.text).toContain('Delegated to Coder')
      // Pure signal: no room post, no board write from this server.
      expect(readRoom(db, { roomId: resolveRoomForTeam('tm1') })).toHaveLength(0)
    })

    it('rejects a call missing the assignee or the task', async () => {
      const leader = await connectInMemory(
        createTeamChatServer(db, { boundIdentity: { ...ident('leader', 'tm1'), delegate: true } }),
      )
      expect((await callText(leader, 'team_delegate', { assignee: ' ', task: 'x' })).isError).toBe(
        true,
      )
      expect(
        (await callText(leader, 'team_delegate', { assignee: 'Coder', task: '' })).isError,
      ).toBe(true)
    })

    it('the name matches the engine observer under MCP namespacing', () => {
      // The engine's DELEGATE_TOOL_NAME_RE (boardOrchestration.ts) — replicated
      // here verbatim because packages/mcp doesn't depend on team-orchestration.
      // If the engine regex ever changes, the apps/web integration test (which
      // imports BOTH sides) is the cross-package guard; this is the fast local one.
      const DELEGATE_TOOL_NAME_RE = /(?:^|[._])delegate(?:[._]|$)/i
      for (const name of [
        'team_delegate',
        'clawboo-teamchat.team_delegate',
        'mcp__clawboo-teamchat__team_delegate',
      ]) {
        expect(DELEGATE_TOOL_NAME_RE.test(name)).toBe(true)
      }
      // And the chat tools must stay DISJOINT from the observer.
      for (const name of ['team_chat_post', 'team_chat_subscribe']) {
        expect(DELEGATE_TOOL_NAME_RE.test(name)).toBe(false)
      }
    })
  })
})
