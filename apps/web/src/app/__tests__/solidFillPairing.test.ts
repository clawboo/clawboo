// Guards the one wiring mistake the token-contrast test cannot see.
//
// `tokenContrast.test.ts` proves the VALUES are sound: a white label on
// `--primary-solid` clears AA. It says nothing about whether a given button
// actually uses that fill. In dark mode `--primary` is the lighter TEXT red, so
// a button that pairs `--primary-foreground` with plain `--primary` renders a
// white label at 3.79:1 — passing every unit test while failing in the browser.
//
// That happened twice while splitting the token: once via `bg-primary` +
// `text-primary-foreground` on one className, and once via an inline
// `background: 'var(--primary)'` that no class-based sweep could see. Only the
// real browser caught the second one. This test closes both holes.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(full, out)
    else if (entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** A label token that may only ever sit on a `-solid` fill. */
const LABELS = [
  { label: 'text-primary-foreground', kind: 'primary' },
  { label: 'text-destructive-foreground', kind: 'destructive' },
  { label: 'var(--primary-foreground)', kind: 'primary' },
  { label: 'var(--destructive-foreground)', kind: 'destructive' },
] as const

/** Brand fills that are NOT valid under a label token, by kind. */
const BAD_FILL: Record<string, RegExp> = {
  // `bg-primary`/`bg-accent`/`var(--primary)` NOT followed by `-solid`, and not
  // an opacity modifier (`bg-primary/10` is a tint, never a button fill).
  primary: /\b(?:bg-primary|bg-accent)\b(?!-solid)(?!\/)|var\(--primary\)/,
  destructive: /\bbg-destructive\b(?!-solid)(?!\/)|var\(--destructive\)/,
}

/** How far around the label to look for the fill — they are usually adjacent,
 *  but a style object can put them a few lines apart. */
const WINDOW = 6

describe('solid-fill pairing', () => {
  it('never pairs a brand label token with a non-solid brand fill', () => {
    const violations: string[] = []

    for (const file of tsxFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const { label, kind } of LABELS) {
          if (!line.includes(label)) continue
          const from = Math.max(0, i - WINDOW)
          const to = Math.min(lines.length, i + WINDOW + 1)
          const near = lines.slice(from, to).join('\n')
          if (BAD_FILL[kind]!.test(near)) {
            violations.push(
              `${path.relative(SRC, file)}:${i + 1} — \`${label}\` sits on a non-solid ` +
                `${kind} fill. In dark mode that renders a white label at ~3.8:1. ` +
                `Use bg-${kind}-solid / var(--${kind}-solid).`,
            )
          }
        }
      })
    }

    expect(violations).toEqual([])
  })
})
