import { describe, expect, it } from 'vitest'

import {
  compactGitStatus,
  compactTestOutput,
  compactToolOutput,
  compactToolResultMarkdown,
  dedupAndElide,
  htmlToText,
  shortenUrls,
  type CompactionRule,
} from '../index'

// Build a vcs-status blob WITHOUT literal shell-command strings in source (the
// rule drops any line starting with "(use ...)", whatever the command is).
function vcsStatus(modifiedCount: number): string {
  const lines = [
    'On branch main',
    "Your branch is up to date with 'origin/main'.",
    '',
    'Changes not staged for commit:',
  ]
  lines.push('  (use "<cmd> <file>..." to update what will be committed)')
  lines.push('  (use "<cmd> <file>..." to discard changes in working directory)')
  for (let i = 0; i < modifiedCount; i++) lines.push(`\tmodified:   src/module-${i}.ts`)
  lines.push(
    '',
    'Untracked files:',
    '  (use "<cmd> <file>..." to include in what will be committed)',
    '\tsrc/new-thing.ts',
    '',
  )
  lines.push('no changes added to commit (use "<cmd>" and/or "<cmd> -a")')
  return lines.join('\n')
}

describe('builtin rules (pure transforms)', () => {
  it('vcs-status keeps changed files + branch, drops hint prose + blanks', () => {
    const input = vcsStatus(3)
    const out = compactGitStatus(input)
    expect(out).toContain('On branch main')
    expect(out).toContain('modified:   src/module-0.ts')
    expect(out).toContain('src/new-thing.ts')
    expect(out).not.toContain('(use "<cmd>')
    expect(out).not.toContain('no changes added')
    expect(out.length).toBeLessThan(input.length)
  })

  it('test-output keeps failures + summary, drops the pass spam', () => {
    const input = [
      '✓ adds two numbers',
      '✓ subtracts',
      '✓ multiplies',
      '✗ divides by zero  → expected Infinity, got NaN',
      'PASS  src/ok.test.ts',
      'Tests: 1 failed, 3 passed, 4 total',
    ].join('\n')
    const out = compactTestOutput(input)
    expect(out).toContain('✗ divides by zero')
    expect(out).toContain('Tests: 1 failed, 3 passed, 4 total')
    expect(out).not.toContain('✓ adds two numbers')
    expect(out).not.toContain('PASS  src/ok.test.ts')
  })

  it('html-to-text strips tags, scripts, and entities', () => {
    const input =
      '<html><head><style>.x{color:red}</style></head><body><h1>Hi</h1><p>A &amp; B</p><script>evil()</script></body></html>'
    const out = htmlToText(input)
    expect(out).toContain('Hi')
    expect(out).toContain('A & B')
    expect(out).not.toContain('<')
    expect(out).not.toContain('evil()')
    expect(out).not.toContain('color:red')
  })

  it('shortenUrls collapses only over-long URLs', () => {
    const short = 'see https://ex.co/a'
    expect(shortenUrls(short)).toBe(short)
    const long = 'docs: https://example.com/' + 'x'.repeat(120)
    const out = shortenUrls(long)
    expect(out).toContain('https://example.com/…[+')
    expect(out.length).toBeLessThan(long.length)
  })

  it('dedupAndElide collapses runs and preserves error lines in the elided middle', () => {
    const lines: string[] = []
    for (let i = 0; i < 12; i++) lines.push('Downloading dependency...') // a collapsible run
    for (let i = 0; i < 10; i++) lines.push(`step ${i} starting`) // distinct → survive dedup
    lines.push('Error: registry timeout on package widget') // in the distinct middle
    for (let i = 10; i < 20; i++) lines.push(`step ${i} continuing`)
    const out = dedupAndElide(lines.join('\n'), { headLines: 3, tailLines: 3 })
    expect(out).toContain('(×12)') // consecutive run collapsed
    expect(out).toContain('lines elided') // distinct middle elided
    expect(out).toContain('Error: registry timeout on package widget') // failure kept
  })
})

describe('compactToolOutput (pass-through-safe + failure-preserving + stats)', () => {
  it('passes through small inputs untouched', () => {
    const r = compactToolOutput('bash', 'tiny output')
    expect(r.stats.applied).toBe(false)
    expect(r.stats.rule).toBe('passthrough-small')
    expect(r.text).toBe('tiny output')
  })

  it('applies a rule and reports honest stats when it saves enough', () => {
    const noisy = Array.from({ length: 300 }, () => 'Compiling crate foo v1.2.3 ...').join('\n')
    const r = compactToolOutput('bash', noisy)
    expect(r.stats.applied).toBe(true)
    expect(r.stats.rule).toBe('dedup-elide')
    expect(r.stats.compactedBytes).toBeLessThan(r.stats.originalBytes)
    expect(r.text).toContain('(×300)')
  })

  it('dispatches to the vcs-status rule by content (not tool name)', () => {
    const input = vcsStatus(12) // padded > 512 bytes
    expect(input.length).toBeGreaterThan(512)
    const r = compactToolOutput('bash', input)
    expect(r.stats.rule).toBe('git-status')
    expect(r.stats.applied).toBe(true)
  })

  it('passes through when savings are below the threshold', () => {
    // 600 bytes of already-tight, non-matching, all-distinct lines.
    const tight = Array.from({ length: 40 }, (_, i) => `unique line ${i} ${'='.repeat(8)}`).join(
      '\n',
    )
    const r = compactToolOutput('bash', tight, { minBytes: 100 })
    expect(r.stats.applied).toBe(false)
    expect(r.stats.rule).toBe('passthrough-low-savings')
    expect(r.text).toBe(tight)
  })

  it('is failure-preserving — a rule that would drop an error falls back to the original', () => {
    const destructive: CompactionRule = { id: 'nuke', matches: () => true, compact: () => 'gone' }
    const input = 'noise '.repeat(120) + '\nError: something broke\n' + 'noise '.repeat(120)
    const r = compactToolOutput('bash', input, { rules: [destructive] })
    expect(r.stats.applied).toBe(false)
    expect(r.stats.rule).toBe('failure-preserve-fallback')
    expect(r.text).toContain('Error: something broke') // verbatim
  })
})

describe('compactToolResultMarkdown (embedded [[tool-result]] blocks)', () => {
  it('compacts the body of each tool-result block, leaves prose untouched', () => {
    const noisy = Array.from({ length: 200 }, () => 'progress tick').join('\n')
    const text = `Here is what I found.\n\n[[tool-result]] bash (call_1)\nexit: 0\n\`\`\`text\n${noisy}\n\`\`\`\n\nThat's the result.`
    const { text: out, stats } = compactToolResultMarkdown(text)
    expect(out).toContain('Here is what I found.') // prose kept
    expect(out).toContain("That's the result.")
    expect(out).toContain('(×200)') // body compacted
    expect(stats).toHaveLength(1)
    expect(stats[0].applied).toBe(true)
  })

  it('leaves a block unchanged when its body is too small to compact', () => {
    const text = `[[tool-result]] read (c1)\n\`\`\`text\nshort body\n\`\`\``
    const { text: out, stats } = compactToolResultMarkdown(text)
    expect(out).toBe(text)
    expect(stats[0].applied).toBe(false)
  })
})
