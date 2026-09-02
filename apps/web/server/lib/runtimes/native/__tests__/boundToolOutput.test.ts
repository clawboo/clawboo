// The native runtime's LOCAL tools were the one path with no size limit.
//
// Everything else crosses the MCP seam, which stores the full result and returns
// a bounded view. Local tools are dispatched in-process and skip it, so a single
// `list_files` against a dependency directory could put a hundred thousand lines
// into a prompt that is then re-sent on every turn.

import { createDb, readToolResult, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { boundToolOutput } from '../boundToolOutput'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const handleIn = (t: string) => /handle (tr_[0-9a-f]+)/.exec(t)?.[1]

describe('boundToolOutput', () => {
  it('leaves an ordinary result completely untouched', () => {
    // The common case by far, and it must not be paying for this.
    const out = 'file a.ts\nfile b.ts\ndir  src'
    expect(boundToolOutput(db, 'list_files', out)).toBe(out)
  })

  it('bounds a directory listing that would otherwise flood the prompt', () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => `file entry-${i}.ts`).join('\n')
    const bounded = boundToolOutput(db, 'list_files', huge)
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(16 * 1024)
    expect(bounded).toContain('list_files')
    expect(bounded).toContain('read_tool_result')
  })

  it('keeps the whole result retrievable, so the trim is not a silent loss', () => {
    const huge = `HEAD${'x'.repeat(80_000)}TAIL`
    const handle = handleIn(boundToolOutput(db, 'read_file', huge))
    expect(handle).toBeDefined()
    const page = readToolResult(db, handle!, { offset: 0, limit: 200 })
    expect(page?.totalBytes).toBe(huge.length)
    expect(page?.text.startsWith('HEAD')).toBe(true)
  })

  it('stores nothing for a result that fits', () => {
    // No row per tool call: the store is for results that were actually cut.
    boundToolOutput(db, 'echo', 'small')
    expect(readToolResult(db, 'tr_0000000000000000', { limit: 10 })).toBeNull()
  })
})
