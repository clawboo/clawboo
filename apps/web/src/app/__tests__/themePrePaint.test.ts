// The theme script in index.html runs before any module, so it cannot import the
// scoped storage helper and spells the theme key itself. This runs the script as
// the page would, against a stub window, and holds its spelling to the helper's:
// the instance at `/a` must paint from its own key, never another instance's.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { scopedStorageKey } from '@/lib/clientStorage'

const html = readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8')
const script = /<script>\s*([\s\S]*?clawboo\.theme[\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

interface Painted {
  dark: boolean
  read: string[]
}

function paint(base: unknown, stored: Record<string, string>): Painted {
  const read: string[] = []
  const classes = new Set<string>()
  const win = {
    __CLAWBOO_BASE__: base,
    localStorage: {
      getItem: (k: string) => {
        read.push(k)
        return stored[k] ?? null
      },
    },
    matchMedia: () => ({ matches: false }),
  }
  const doc = {
    documentElement: {
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    },
  }
  new Function('window', 'document', script)(win, doc)
  return { dark: classes.has('dark'), read }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('index.html theme pre-paint', () => {
  it('is present', () => {
    expect(script).toContain('localStorage')
  })

  it("paints from the instance's own key under a base path", () => {
    expect(paint('/a', { '/a:clawboo.theme': 'dark' }).dark).toBe(true)
    expect(paint('/a', { '/b:clawboo.theme': 'dark' }).dark).toBe(false)
    expect(paint('/a', { '/a:clawboo.theme': 'light', 'clawboo.theme': 'dark' }).dark).toBe(false)
  })

  it('falls back to a theme stored before the prefix existed', () => {
    expect(paint('/a', { 'clawboo.theme': 'dark' }).dark).toBe(true)
  })

  it('reads the key it always read at the root', () => {
    expect(paint(undefined, { 'clawboo.theme': 'dark' }).read).toEqual(['clawboo.theme'])
    expect(paint('/', { 'clawboo.theme': 'dark' }).dark).toBe(true)
  })

  it('spells the key exactly as the storage helper does', () => {
    for (const base of ['/a', '/team/a/', ' /x ', 'nolead', '///', '', undefined]) {
      vi.stubGlobal('__CLAWBOO_BASE__', base)
      expect(paint(base, {}).read[0]).toBe(scopedStorageKey('clawboo.theme'))
    }
  })
})
