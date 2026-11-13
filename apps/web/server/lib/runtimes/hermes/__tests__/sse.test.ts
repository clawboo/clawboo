import { describe, expect, it } from 'vitest'

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
})
