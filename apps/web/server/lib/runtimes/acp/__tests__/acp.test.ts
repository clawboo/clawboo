// The generic ACP client pieces: the JSON-RPC connection and how session updates
// and prompt results read. Agent-neutral, so another ACP agent can reuse them.

import { describe, expect, it } from 'vitest'

import { AcpRequestError, allowOption, createAcpConnection } from '../connection'
import { acpPromptUsage, acpStopReason, normalizeAcpUpdate } from '../updates'

function wire() {
  const sent: Array<Record<string, unknown>> = []
  const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = []
  const conn = createAcpConnection({
    write: (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
    onSessionUpdate: (sessionId, update) => updates.push({ sessionId, update }),
  })
  return { conn, sent, updates }
}

describe('createAcpConnection', () => {
  it('pairs each answer with its request', async () => {
    const { conn, sent } = wire()
    const a = conn.request('initialize', { protocolVersion: 1 })
    const b = conn.request('session/new', { cwd: '/w', mcpServers: [] })
    expect(sent.map((m) => [m['jsonrpc'], m['id'], m['method']])).toEqual([
      ['2.0', 1, 'initialize'],
      ['2.0', 2, 'session/new'],
    ])
    conn.onLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }))
    conn.onLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }))
    await expect(a).resolves.toEqual({ protocolVersion: 1 })
    await expect(b).resolves.toEqual({ sessionId: 's' })
  })

  it("rejects with the agent's error", async () => {
    const { conn } = wire()
    const p = conn.request('session/load', { sessionId: 'x' })
    conn.onLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'not found' } }),
    )
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AcpRequestError)
    expect(err).toMatchObject({ message: 'not found', code: -32002 })
  })

  it('hands session updates on, and ignores lines that are not protocol', () => {
    const { conn, updates } = wire()
    conn.onLine('Hermes v0.19.0 starting')
    conn.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } },
      }),
    )
    expect(updates).toEqual([{ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } }])
  })

  it('answers a permission request with allow-once by default', () => {
    const { conn, sent } = wire()
    conn.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'p1',
        method: 'session/request_permission',
        params: {
          options: [
            { optionId: 'no', kind: 'reject_once' },
            { optionId: 'always', kind: 'allow_always' },
            { optionId: 'once', kind: 'allow_once' },
          ],
        },
      }),
    )
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 'p1', result: { outcome: { outcome: 'selected', optionId: 'once' } } },
    ])
  })

  it('cancels a permission request with nothing to allow, and refuses what it did not offer', () => {
    const { conn, sent } = wire()
    conn.onLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'no', kind: 'reject_once' }] },
      }),
    )
    conn.onLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'terminal/create', params: {} }))
    expect(sent[0]).toMatchObject({ id: 1, result: { outcome: { outcome: 'cancelled' } } })
    expect(sent[1]).toMatchObject({ id: 2, error: { code: -32601 } })
  })

  it('rejects what is still waiting once closed, and anything asked after', async () => {
    const { conn } = wire()
    const p = conn.request('session/prompt', {})
    conn.close('agent exited')
    await expect(p).rejects.toThrow('agent exited')
    await expect(conn.request('session/prompt', {})).rejects.toThrow('agent exited')
  })

  it('allowOption prefers allow-once, then allow-always', () => {
    expect(allowOption([{ optionId: 'a', kind: 'allow_always' }])).toBe('a')
    expect(allowOption([{ optionId: 'r', kind: 'reject_always' }])).toBeNull()
  })
})

describe('normalizeAcpUpdate', () => {
  it('reads text and reasoning chunks', () => {
    expect(
      normalizeAcpUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toEqual([{ kind: 'text', text: 'hi', channel: 'assistant' }])
    expect(
      normalizeAcpUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'hmm' },
      }),
    ).toEqual([{ kind: 'text', text: 'hmm', channel: 'reasoning' }])
    // A non-text block (an image) carries no text.
    expect(
      normalizeAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } }),
    ).toEqual([])
  })

  it('reads a tool call from its start to its terminal status', () => {
    expect(
      normalizeAcpUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read_file: a.ts',
        kind: 'read',
        status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text: '{"path":"a.ts"}' } }],
      }),
    ).toEqual([
      {
        kind: 'tool-start',
        id: 't1',
        title: 'read_file: a.ts',
        toolKind: 'read',
        input: '{"path":"a.ts"}',
      },
    ])
    // Progress without a terminal status ends nothing.
    expect(
      normalizeAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
      }),
    ).toEqual([])
    expect(
      normalizeAcpUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'failed',
        rawOutput: { error: 'no such file' },
      }),
    ).toEqual([{ kind: 'tool-end', id: 't1', output: '{"error":"no such file"}', failed: true }])
  })

  it('ends a call that arrives already finished', () => {
    expect(
      normalizeAcpUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'todo',
        status: 'completed',
        rawOutput: 'ok',
      }),
    ).toMatchObject([{ kind: 'tool-start' }, { kind: 'tool-end', output: 'ok', failed: false }])
  })

  it('maps plans, gauges, mode changes and echoes of the prompt to nothing', () => {
    for (const sessionUpdate of [
      'plan',
      'usage_update',
      'current_mode_update',
      'available_commands_update',
      'user_message_chunk',
      'session_info_update',
    ])
      expect(normalizeAcpUpdate({ sessionUpdate })).toEqual([])
  })
})

describe('the prompt result', () => {
  it('reads usage, with cached input when reported', () => {
    expect(
      acpPromptUsage({
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: 4 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 })
    expect(acpPromptUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(acpPromptUsage({ usage: {} })).toBeUndefined()
  })

  it('reads the stop reason', () => {
    expect(acpStopReason({ stopReason: 'cancelled' })).toBe('cancelled')
    expect(acpStopReason(null)).toBeUndefined()
  })
})
