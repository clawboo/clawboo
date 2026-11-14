import { describe, expect, it, vi } from 'vitest'

import { createSseReader, type SseEvent } from '../sse'

function read(chunks: string[], opts?: Parameters<typeof createSseReader>[1]): SseEvent[] {
  const out: SseEvent[] = []
  const r = createSseReader((ev) => out.push(ev), opts)
  for (const c of chunks) r.push(c)
  r.end()
  return out
}

describe('createSseReader', () => {
  it('reads named events, joins data lines and keeps the last id', () => {
    const out = read(['id: 1\nevent: run.delta\ndata: {"a":1}\n\n', 'id: 2\ndata: x\ndata: y\n\n'])
    expect(out).toEqual([
      { event: 'run.delta', data: '{"a":1}', id: '1' },
      { event: 'message', data: 'x\ny', id: '2' },
    ])
  })

  it('handles any split, including inside a CRLF pair', () => {
    const text = 'event: a\r\ndata: one\r\n\r\nevent: b\r\ndata: two\r\n\r\n'
    for (let cut = 1; cut < text.length; cut++) {
      const out = read([text.slice(0, cut), text.slice(cut)])
      expect(out.map((e) => `${e.event}=${e.data}`)).toEqual(['a=one', 'b=two'])
    }
  })

  it('skips comments and events with no data, and drops an unfinished last event', () => {
    const out = read([': keepalive\n\n', 'event: lone\n\n', 'data: done\n\n', 'data: cut off'])
    expect(out).toEqual([{ event: 'message', data: 'done', id: null }])
  })

  it('stops reading a stream whose event grows past the limit', () => {
    let overflowed = 0
    const out = read(['data: ', 'x'.repeat(50), '\n\n', 'data: after\n\n'], {
      maxEventChars: 20,
      onOverflow: () => (overflowed += 1),
    })
    expect(overflowed).toBe(1)
    expect(out).toEqual([])
  })

  it('never delivers an oversized event that arrives whole in one chunk', () => {
    let overflowed = 0
    const out = read(['data: ' + 'x'.repeat(50) + '\n\ndata: after\n\n'], {
      maxEventChars: 20,
      onOverflow: () => (overflowed += 1),
    })
    expect(overflowed).toBe(1)
    expect(out).toEqual([])
  })

  it('counts every data line of an event toward the limit, before it is delivered', () => {
    let overflowed = 0
    const out = read(['data: ' + 'x'.repeat(12) + '\ndata: ' + 'y'.repeat(12) + '\n\n'], {
      maxEventChars: 20,
      onOverflow: () => (overflowed += 1),
    })
    expect(overflowed).toBe(1)
    expect(out).toEqual([])
  })

  it('looks at each character of a long line once, however it is split', () => {
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    try {
      const line = 'data: ' + 'x'.repeat(16 * 1024)
      const r = createSseReader(() => undefined)
      charCodeAt.mockClear()
      for (let i = 0; i < line.length; i += 16) r.push(line.slice(i, i + 16))
      // Rescanning the unfinished line on every chunk would look ~8 million times.
      expect(charCodeAt.mock.calls.length).toBeLessThan(4 * line.length)
    } finally {
      charCodeAt.mockRestore()
    }
  })

  it('keeps reading after a lone CR that ends one chunk and a long line split around it', () => {
    const out = read(['data: one\r', '\ndata: two\r', '\n\r', '\n'])
    expect(out).toEqual([{ event: 'message', data: 'one\ntwo', id: null }])
  })
})
