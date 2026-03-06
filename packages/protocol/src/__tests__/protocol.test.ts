import { describe, it, expect } from 'vitest'
import {
  extractText,
  extractThinking,
  extractToolLines,
  stripUiMetadata,
  isHeartbeatPrompt,
  parseMessage,
  isAgentFileName,
  formatMetaMarkdown,
  parseMetaMarkdown,
  isTraceMarkdown,
  isToolMarkdown,
  isMetaMarkdown,
  parseToolMarkdown,
} from '../index'

// ─── extractText ──────────────────────────────────────────────────────────────

describe('extractText', () => {
  it('extracts text from a message with string content', () => {
    const msg = { content: 'Hello world' }
    expect(extractText(msg)).toBe('Hello world')
  })

  it('extracts text from a message with content blocks array', () => {
    const msg = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    }
    expect(extractText(msg)).toBe('first\nsecond')
  })

  it('extracts text from a message with a top-level text field', () => {
    const msg = { text: 'fallback text' }
    expect(extractText(msg)).toBe('fallback text')
  })

  it('strips thinking tags from assistant messages', () => {
    const msg = {
      role: 'assistant',
      content: '<thinking>internal</thinking>visible text',
    }
    expect(extractText(msg)).toBe('visible text')
  })

  it('strips assistant prefix [[reply_to_current]]', () => {
    const msg = {
      role: 'assistant',
      content: '[[reply_to_current]] actual reply',
    }
    expect(extractText(msg)).toBe('actual reply')
  })

  it('returns null for null input', () => {
    expect(extractText(null)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(extractText('just a string')).toBeNull()
  })

  it('returns null for object with no content or text', () => {
    expect(extractText({ foo: 'bar' })).toBeNull()
  })

  it('ignores non-text content blocks', () => {
    const msg = {
      content: [
        { type: 'image', url: 'test.png' },
        { type: 'text', text: 'only this' },
      ],
    }
    expect(extractText(msg)).toBe('only this')
  })

  it('strips exec approval policy suffix from non-assistant messages', () => {
    const policy = [
      'Execution approval policy:',
      '- If any tool result says approval is required or pending, stop immediately.',
      '- Do not call additional tools and do not switch to alternate approaches.',
      'If approved command output is unavailable, reply exactly: "Waiting for approved command result."',
    ].join('\n')
    const msg = { content: `User question\n\n${policy}` }
    expect(extractText(msg)).toBe('User question')
  })
})

// ─── extractThinking ──────────────────────────────────────────────────────────

describe('extractThinking', () => {
  it('extracts thinking from content block with type=thinking', () => {
    const msg = {
      content: [{ type: 'thinking', thinking: 'deep thought' }],
    }
    expect(extractThinking(msg)).toBe('deep thought')
  })

  it('extracts thinking from content block with text field when type=thinking', () => {
    const msg = {
      content: [{ type: 'thinking', text: 'thought via text field' }],
    }
    expect(extractThinking(msg)).toBe('thought via text field')
  })

  it('extracts thinking from direct field on message object', () => {
    const msg = { thinking: 'direct thinking' }
    expect(extractThinking(msg)).toBe('direct thinking')
  })

  it('extracts thinking from inline <thinking> tags in content', () => {
    const msg = {
      content: '<thinking>tagged thought</thinking>visible',
    }
    expect(extractThinking(msg)).toBe('tagged thought')
  })

  it('extracts from analysis type blocks', () => {
    const msg = {
      content: [{ type: 'analysis', text: 'analysis content' }],
    }
    expect(extractThinking(msg)).toBe('analysis content')
  })

  it('extracts from direct reasoning field', () => {
    const msg = { reasoning: 'reasoning content' }
    expect(extractThinking(msg)).toBe('reasoning content')
  })

  it('returns null for message with no thinking', () => {
    const msg = { content: 'just normal text' }
    expect(extractThinking(msg)).toBeNull()
  })

  it('returns null for null input', () => {
    expect(extractThinking(null)).toBeNull()
  })

  it('returns null for non-object input', () => {
    expect(extractThinking(42)).toBeNull()
  })

  it('joins multiple thinking blocks', () => {
    const msg = {
      content: [
        { type: 'thinking', thinking: 'thought 1' },
        { type: 'thinking', thinking: 'thought 2' },
      ],
    }
    expect(extractThinking(msg)).toBe('thought 1\nthought 2')
  })
})

// ─── extractToolLines ─────────────────────────────────────────────────────────

describe('extractToolLines', () => {
  it('returns formatted lines for tool calls in content blocks', () => {
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'readFile',
          id: 'tc1',
          arguments: { path: '/tmp/test.txt' },
        },
      ],
    }
    const lines = extractToolLines(msg)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[[tool]]')
    expect(lines[0]).toContain('readFile')
  })

  it('returns formatted line for tool result message', () => {
    const msg = {
      role: 'toolResult',
      toolName: 'readFile',
      toolCallId: 'tc1',
      content: 'file contents here',
    }
    const lines = extractToolLines(msg)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[[tool-result]]')
    expect(lines[0]).toContain('readFile')
  })

  it('returns empty array for message with no tools', () => {
    const msg = { content: 'just text' }
    expect(extractToolLines(msg)).toEqual([])
  })

  it('returns empty array for null input', () => {
    expect(extractToolLines(null)).toEqual([])
  })

  it('handles both tool calls and tool results in one pass', () => {
    // Tool calls come from content blocks, tool results come from the message role
    const callMsg = {
      content: [{ type: 'toolCall', name: 'bash', arguments: { cmd: 'ls' } }],
    }
    const resultMsg = {
      role: 'toolResult',
      toolName: 'bash',
      content: 'output',
    }
    expect(extractToolLines(callMsg).length).toBeGreaterThan(0)
    expect(extractToolLines(resultMsg).length).toBeGreaterThan(0)
  })
})

// ─── stripUiMetadata ──────────────────────────────────────────────────────────

describe('stripUiMetadata', () => {
  it('returns clean text unchanged', () => {
    expect(stripUiMetadata('Hello world')).toBe('Hello world')
  })

  it('strips message_id injections', () => {
    // MESSAGE_ID_RE consumes surrounding whitespace, so spaces around the tag are removed
    expect(stripUiMetadata('Hello [message_id:abc123] world')).toBe('Helloworld')
  })

  it('strips project path blocks', () => {
    const text = 'Project path: /home/user/project\n\nActual message'
    expect(stripUiMetadata(text)).toBe('Actual message')
  })

  it('strips session reset prompt blocks', () => {
    const text =
      'A new session was started via /new or /reset. Begin fresh reasoning.\n\nActual content'
    const result = stripUiMetadata(text)
    expect(result).not.toContain('/new or /reset')
  })

  it('returns empty string for empty input', () => {
    expect(stripUiMetadata('')).toBe('')
  })

  it('strips system event blocks', () => {
    const text = 'System: [event_name] some details\n\nReal content'
    expect(stripUiMetadata(text)).toBe('Real content')
  })
})

// ─── isHeartbeatPrompt ────────────────────────────────────────────────────────

describe('isHeartbeatPrompt', () => {
  it('returns true for heartbeat prompt text', () => {
    expect(isHeartbeatPrompt('Read HEARTBEAT.md if it exists and follow it')).toBe(true)
  })

  it('returns true for heartbeat file path text', () => {
    expect(isHeartbeatPrompt('Heartbeat file path: /some/path')).toBe(true)
  })

  it('returns false for regular text', () => {
    expect(isHeartbeatPrompt('Hello, how are you?')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isHeartbeatPrompt('')).toBe(false)
  })

  it('handles whitespace around heartbeat text', () => {
    expect(isHeartbeatPrompt('  Read HEARTBEAT.md if it exists  ')).toBe(true)
  })
})

// ─── parseMessage ─────────────────────────────────────────────────────────────

describe('parseMessage', () => {
  it('returns full ParsedMessage with text + thinking + tools', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I need to think' },
        { type: 'text', text: 'Here is my answer' },
        {
          type: 'toolCall',
          name: 'bash',
          id: 'tc1',
          arguments: { cmd: 'ls' },
        },
      ],
      timestamp: 1700000000000,
    }
    const parsed = parseMessage(msg)
    expect(parsed.text).toContain('Here is my answer')
    expect(parsed.thinking).toBe('I need to think')
    expect(parsed.toolCalls).toHaveLength(1)
    expect(parsed.toolCalls[0].name).toBe('bash')
    expect(parsed.metadata.role).toBe('assistant')
    expect(parsed.metadata.timestamp).toBe(1700000000000)
  })

  it('handles message with no thinking', () => {
    const msg = { role: 'user', content: 'Hello' }
    const parsed = parseMessage(msg)
    expect(parsed.text).toBe('Hello')
    expect(parsed.thinking).toBeNull()
    expect(parsed.toolCalls).toHaveLength(0)
    expect(parsed.toolResults).toHaveLength(0)
    expect(parsed.metadata.role).toBe('user')
  })

  it('handles tool result messages', () => {
    const msg = {
      role: 'toolResult',
      toolName: 'readFile',
      toolCallId: 'tc1',
      content: 'file data',
      isError: false,
    }
    const parsed = parseMessage(msg)
    expect(parsed.toolResults).toHaveLength(1)
    expect(parsed.toolResults[0].name).toBe('readFile')
    expect(parsed.toolResults[0].output).toBe('file data')
  })

  it('returns empty text for null input', () => {
    const parsed = parseMessage(null)
    expect(parsed.text).toBe('')
    expect(parsed.thinking).toBeNull()
    expect(parsed.toolCalls).toHaveLength(0)
    expect(parsed.toolResults).toHaveLength(0)
  })

  it('reads timestamp from createdAt fallback', () => {
    const msg = { role: 'assistant', content: 'Hi', createdAt: 1234567890 }
    const parsed = parseMessage(msg)
    expect(parsed.metadata.timestamp).toBe(1234567890)
  })

  it('handles tool call with no arguments', () => {
    const msg = {
      content: [{ type: 'toolCall', name: 'status' }],
    }
    const parsed = parseMessage(msg)
    expect(parsed.toolCalls).toHaveLength(1)
    expect(parsed.toolCalls[0].name).toBe('status')
    expect(parsed.toolCalls[0].arguments).toEqual({})
  })
})

// ─── Agent file helpers ───────────────────────────────────────────────────────

describe('isAgentFileName', () => {
  it('returns true for valid agent file names', () => {
    expect(isAgentFileName('SOUL.md')).toBe(true)
    expect(isAgentFileName('AGENTS.md')).toBe(true)
    expect(isAgentFileName('TOOLS.md')).toBe(true)
    expect(isAgentFileName('HEARTBEAT.md')).toBe(true)
    expect(isAgentFileName('MEMORY.md')).toBe(true)
  })

  it('returns false for invalid names', () => {
    expect(isAgentFileName('README.md')).toBe(false)
    expect(isAgentFileName('soul.md')).toBe(false)
    expect(isAgentFileName('')).toBe(false)
  })
})

// ─── Markdown helpers ─────────────────────────────────────────────────────────

describe('formatMetaMarkdown', () => {
  it('formats meta with role and timestamp', () => {
    const result = formatMetaMarkdown({
      role: 'user',
      timestamp: 1700000000000,
    })
    expect(result).toContain('[[meta]]')
    expect(result).toContain('"role":"user"')
    expect(result).toContain('"timestamp":1700000000000')
  })

  it('includes thinkingDurationMs when provided', () => {
    const result = formatMetaMarkdown({
      role: 'assistant',
      timestamp: 1700000000000,
      thinkingDurationMs: 500,
    })
    expect(result).toContain('"thinkingDurationMs":500')
  })
})

describe('parseMetaMarkdown', () => {
  it('round-trips with formatMetaMarkdown', () => {
    const meta = { role: 'assistant' as const, timestamp: 1700000000000 }
    const formatted = formatMetaMarkdown(meta)
    const parsed = parseMetaMarkdown(formatted)
    expect(parsed).not.toBeNull()
    expect(parsed!.role).toBe('assistant')
    expect(parsed!.timestamp).toBe(1700000000000)
  })

  it('returns null for non-meta lines', () => {
    expect(parseMetaMarkdown('regular text')).toBeNull()
  })

  it('returns null for invalid JSON after prefix', () => {
    expect(parseMetaMarkdown('[[meta]]not json')).toBeNull()
  })
})

describe('markdown type guards', () => {
  it('isTraceMarkdown detects trace lines', () => {
    expect(isTraceMarkdown('[[trace]] some trace')).toBe(true)
    expect(isTraceMarkdown('normal text')).toBe(false)
  })

  it('isToolMarkdown detects tool call and result lines', () => {
    expect(isToolMarkdown('[[tool]] bash')).toBe(true)
    expect(isToolMarkdown('[[tool-result]] bash')).toBe(true)
    expect(isToolMarkdown('regular text')).toBe(false)
  })

  it('isMetaMarkdown detects meta lines', () => {
    expect(isMetaMarkdown('[[meta]]{"role":"user"}')).toBe(true)
    expect(isMetaMarkdown('not meta')).toBe(false)
  })
})

describe('parseToolMarkdown', () => {
  it('parses a tool call line', () => {
    const result = parseToolMarkdown('[[tool]] readFile (tc1)\n```json\n{"path":"/tmp"}\n```')
    expect(result.kind).toBe('call')
    expect(result.label).toBe('readFile (tc1)')
    expect(result.body).toContain('{"path":"/tmp"}')
  })

  it('parses a tool result line', () => {
    const result = parseToolMarkdown('[[tool-result]] readFile')
    expect(result.kind).toBe('result')
    expect(result.label).toBe('readFile')
  })
})
