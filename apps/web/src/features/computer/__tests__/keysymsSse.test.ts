import { describe, expect, it } from 'vitest'

import { keysymFor } from '../keysyms'
import { createSseParser, type SseEvent } from '../sse'

describe('keysymFor', () => {
  it('maps named keys, the right-hand modifiers, and printed characters', () => {
    expect(keysymFor({ key: 'Enter' })).toBe(0xff0d)
    expect(keysymFor({ key: 'Backspace' })).toBe(0xff08)
    expect(keysymFor({ key: 'Tab' })).toBe(0xff09)
    expect(keysymFor({ key: 'Shift', location: 1 })).toBe(0xffe1)
    expect(keysymFor({ key: 'Shift', location: 2 })).toBe(0xffe2)
    expect(keysymFor({ key: 'a' })).toBe(0x61)
    expect(keysymFor({ key: 'A' })).toBe(0x41)
    expect(keysymFor({ key: ' ' })).toBe(0x20)
    expect(keysymFor({ key: 'é' })).toBe(0xe9)
    expect(keysymFor({ key: '€' })).toBe(0x01000000 + 0x20ac)
    expect(keysymFor({ key: '😀' })).toBe(0x01000000 + 0x1f600)
  })

  it('sends nothing for a key with no meaning to the display', () => {
    expect(keysymFor({ key: 'Dead' })).toBeNull()
    expect(keysymFor({ key: 'Unidentified' })).toBeNull()
    expect(keysymFor({ key: '\u0007' })).toBeNull()
  })
})

describe('createSseParser', () => {
  it('reads events split anywhere across chunks, and skips comments', () => {
    const got: SseEvent[] = []
    const push = createSseParser((e) => got.push(e))
    push(': ping\n\nevent: hel')
    push('lo\ndata: {"viewerId":"v1"}\n')
    push('\nevent: rects\ndata: {"a":1}\r\n\r\n')
    expect(got).toEqual([
      { event: 'hello', data: '{"viewerId":"v1"}' },
      { event: 'rects', data: '{"a":1}' },
    ])
  })
})
