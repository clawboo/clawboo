import { describe, expect, it } from 'vitest'

import { agentIdFromDirectChatKey, directChatSessionKey } from '../directChatSessionKey'

describe('directChatSessionKey', () => {
  it('keeps the native key and names the runtime for the others', () => {
    expect(directChatSessionKey('a1', 'clawboo-native')).toBe('agent:a1:native')
    expect(directChatSessionKey('a1', 'claude-code')).toBe('agent:a1:claude-code')
    expect(directChatSessionKey('a1', 'codex')).toBe('agent:a1:codex')
    expect(directChatSessionKey('a1', 'hermes')).toBe('agent:a1:hermes')
    expect(directChatSessionKey('a1', null)).toBe('agent:a1:native')
  })

  it('recognises every server-run 1:1 key and nothing else', () => {
    expect(agentIdFromDirectChatKey('agent:a1:native')).toBe('a1')
    expect(agentIdFromDirectChatKey('agent:a1:claude-code')).toBe('a1')
    expect(agentIdFromDirectChatKey('agent:a1:codex')).toBe('a1')
    expect(agentIdFromDirectChatKey('agent:a1:hermes')).toBe('a1')
    // OpenClaw's own keys, team keys and room keys are not a server-run 1:1 chat.
    expect(agentIdFromDirectChatKey('agent:a1:main')).toBeNull()
    expect(agentIdFromDirectChatKey('agent:a1:team:t1')).toBeNull()
    expect(agentIdFromDirectChatKey('agent:a1:team:t1:room:r1')).toBeNull()
    expect(agentIdFromDirectChatKey('teamchat:t1')).toBeNull()
  })
})
