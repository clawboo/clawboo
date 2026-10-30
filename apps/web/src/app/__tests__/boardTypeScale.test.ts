// Keeps the Board on its closed type scale and its two text colours.
//
// The board sets type only through the role utilities: `text-micro` (11),
// `text-xs` (12), `text-compact` (13), `text-sm` (14), `text-base` (16),
// `text-xl` (20) and their neighbours on the scale. Two sizes a pixel or half a
// pixel apart read as the same size, but wrong, so an arbitrary size is not
// allowed back in, in a class or in an inline style. Text colour is
// `text-foreground` or `text-muted-foreground`: an opacity of the foreground
// fails the muted-text contract below /60 in light mode, so none is allowed.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BOARD = path.join(SRC, 'features', 'board')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const RULES = [
  { name: 'an arbitrary text size', re: /\btext-\[\d/ },
  { name: 'a numeric inline fontSize', re: /\bfontSize\s*:\s*['"`]?\d/ },
  { name: 'text as an opacity of the foreground', re: /\btext-foreground\/(?:\d|\[)/ },
] as const

describe('the Board type scale', () => {
  it('finds the board source', () => {
    expect(sourceFiles(BOARD).length).toBeGreaterThan(10)
  })

  it('sets every size from the scale and every text colour from a token', () => {
    const violations: string[] = []
    for (const file of sourceFiles(BOARD)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const { name, re } of RULES) {
            if (re.test(line)) {
              violations.push(`${path.relative(SRC, file)}:${i + 1} ${name}: ${line.trim()}`)
            }
          }
        })
    }
    expect(violations).toEqual([])
  })

  it('catches each kind of drift', () => {
    const caught = (line: string) => RULES.some(({ re }) => re.test(line))
    expect(caught('className="text-[12.5px] font-semibold"')).toBe(true)
    expect(caught('className="text-[0.8rem]"')).toBe(true)
    expect(caught('style={{ fontSize: 11 }}')).toBe(true)
    expect(caught("style={{ fontSize: '13px' }}")).toBe(true)
    expect(caught('className="text-foreground/70"')).toBe(true)
    expect(caught('className="placeholder:text-foreground/35"')).toBe(true)
    expect(caught('className="text-foreground/[0.6]"')).toBe(true)
    // What the board uses instead.
    expect(caught('className="text-xs text-muted-foreground"')).toBe(false)
    expect(caught('className="text-sm font-medium text-foreground"')).toBe(false)
    expect(caught('className="line-through decoration-foreground/30"')).toBe(false)
    expect(caught('className="bg-foreground/[0.06] hover:bg-foreground/[0.05]"')).toBe(false)
    expect(caught('className="text-[var(--amber)]"')).toBe(false)
  })
})
