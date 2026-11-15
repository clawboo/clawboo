// A folder listing the agent host sends back is one reply line, so it stops at
// the reply budget, and it yields as it goes so the host keeps answering its
// pings. Every listing goes through collectEntries, the descriptor-based one a
// user per agent uses on Linux included, so these limits are checked here,
// where no /proc is needed.

import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { collectEntries } from '../../../agentHost/fsOps'
import { MAX_LIST_REPLY_CHARS } from '../protocol'

const fileStat = (): Promise<fs.Stats> =>
  Promise.resolve({
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false,
    size: 1,
    mtimeMs: 0,
  } as unknown as fs.Stats)

describe('collectEntries', () => {
  it('stops at the reply budget and says the list is cut', async () => {
    // Each name costs about 2 * length + 96 characters of reply.
    const name = 'x'.repeat(4000)
    const count = Math.ceil(MAX_LIST_REPLY_CHARS / (name.length * 2 + 96)) + 10
    const names = Array.from({ length: count }, (_, i) => `${name}${String(i).padStart(6, '0')}`)
    const out = await collectEntries(names, 100_000, fileStat, () => Promise.resolve())
    expect(out.truncated).toBe(true)
    expect(out.entries.length).toBeLessThan(count)
    const replyChars = out.entries.reduce((n, e) => n + e.name.length * 2 + 96, 0)
    expect(replyChars).toBeLessThanOrEqual(MAX_LIST_REPLY_CHARS)
  })

  it('yields while it works through a long folder', async () => {
    const names = Array.from({ length: 2000 }, (_, i) => `f${i}`)
    let yields = 0
    const out = await collectEntries(names, 100_000, fileStat, () => {
      yields++
      return Promise.resolve()
    })
    expect(out.entries).toHaveLength(2000)
    expect(out.truncated).toBe(false)
    expect(yields).toBe(3)
  })

  it('takes at most max entries and says when it left some out', async () => {
    const names = ['a', 'b', 'c', 'd']
    const out = await collectEntries(names, 2, fileStat, () => Promise.resolve())
    expect(out.entries.map((e) => e.name)).toEqual(['a', 'b'])
    expect(out.truncated).toBe(true)
  })

  it('skips an entry that went between the listing and the look', async () => {
    const look = (name: string): Promise<fs.Stats> =>
      name === 'gone' ? Promise.reject(new Error('ENOENT')) : fileStat()
    const out = await collectEntries(['a', 'gone', 'b'], 10, look, () => Promise.resolve())
    expect(out.entries.map((e) => e.name)).toEqual(['a', 'b'])
    expect(out.truncated).toBe(false)
  })
})
