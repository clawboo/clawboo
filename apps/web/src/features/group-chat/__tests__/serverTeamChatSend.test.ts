// serverTeamChatSend — the thin-client REST send + stop for native teams. Verifies
// the optimistic user bubble lands under the target's team key, the POST body
// carries { message, targetAgentId, entryId } (entryId matches the optimistic
// entry so the SSE-replayed user entry dedups), and Stop clears local streaming +
// POSTs /chat/stop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatStore } from '@/stores/chat'

import { sendServerTeamMessage, stopServerTeam } from '../serverTeamChatSend'

function resetChatStore(): void {
  useChatStore.setState({
    transcripts: new Map(),
    streamingText: new Map(),
    streamStartedAt: new Map(),
    lastTokenUsage: new Map(),
  })
}

describe('sendServerTeamMessage', () => {
  beforeEach(() => resetChatStore())
  afterEach(() => vi.unstubAllGlobals())

  it('optimistically appends the user entry under the target key and POSTs {message,targetAgentId,entryId}', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const sk = 'agent:a2:team:t1'
    await sendServerTeamMessage({
      teamId: 't1',
      targetAgentId: 'a2',
      targetSessionKey: sk,
      message: 'fix the bug',
    })

    // Optimistic bubble under the target key.
    const entries = useChatStore.getState().transcripts.get(sk)
    expect(entries).toHaveLength(1)
    expect(entries![0]).toMatchObject({ role: 'user', kind: 'user', text: 'fix the bug', sessionKey: sk })
    const optimisticEntryId = entries![0]!.entryId

    // POST body carries the SAME entryId (deterministic dedup with the SSE replay).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/teams/t1/chat')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ message: 'fix the bug', targetAgentId: 'a2', entryId: optimisticEntryId })
  })

  it('keeps the optimistic bubble even when the POST fails (intent preserved)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const sk = 'agent:a2:team:t1'
    await sendServerTeamMessage({ teamId: 't1', targetAgentId: 'a2', targetSessionKey: sk, message: 'hi' })
    expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(1)
  })
})

describe('stopServerTeam', () => {
  beforeEach(() => resetChatStore())
  afterEach(() => vi.unstubAllGlobals())

  it('clears local streaming state for each session and POSTs /chat/stop', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const sk1 = 'agent:a1:team:t1'
    const sk2 = 'agent:a2:team:t1'
    const chat = useChatStore.getState()
    chat.setStreamingText(sk1, 'partial…')
    chat.setStreamStart(sk1, 123)
    chat.setStreamingText(sk2, 'more…')

    await stopServerTeam({ teamId: 't1', sessionKeys: [sk1, sk2] })

    expect(useChatStore.getState().streamingText.get(sk1)).toBeUndefined()
    expect(useChatStore.getState().streamingText.get(sk2)).toBeUndefined()
    expect(useChatStore.getState().streamStartedAt.get(sk1)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/teams/t1/chat/stop', { method: 'POST' })
  })
})
