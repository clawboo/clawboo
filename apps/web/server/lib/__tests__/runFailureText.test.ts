// The sentence a user reads when a run produced nothing.
//
// Team delivery drives four runtimes through this, so the remediation has to name
// the runtime that actually failed. Only the native one raises the missing-key
// error today, but a hardcoded destination would start misdirecting silently the
// moment another one did, and a user sent to the wrong runtime's settings cannot
// fix anything there.

import { describe, expect, it } from 'vitest'

import { runFailureText } from '../runFailureText'

const NO_KEY = 'no provider key available (checked ANTHROPIC_API_KEY and fallbacks)'

describe('runFailureText', () => {
  it('points a missing key at the runtime that raised it', () => {
    const text = runFailureText(NO_KEY, 'clawboo-native')
    expect(text).toContain('Clawboo Native')
    expect(text).toMatch(/Settings/)
  })

  it('names a NON-native runtime rather than sending the user to Clawboo Native', () => {
    const text = runFailureText(NO_KEY, 'hermes')
    expect(text).not.toContain('Clawboo Native')
    expect(text).toContain('Hermes')
  })

  it('stays runtime-neutral when the runtime is unknown or absent', () => {
    for (const runtime of [undefined, null, 'not-a-runtime']) {
      const text = runFailureText(NO_KEY, runtime)
      expect(text).not.toContain('Clawboo Native')
      expect(text).toMatch(/Settings/)
    }
  })

  it('reports any other failure verbatim rather than guessing a cause', () => {
    expect(runFailureText('upstream 503', 'clawboo-native')).toBe('The run failed: upstream 503')
    expect(runFailureText(null, 'clawboo-native')).toBe('The run failed: unknown error')
  })
})

// ── The context-overflow label ───────────────────────────────────────────────
// Added after an operator was sent round the same loop five times. The runtime's
// own advice is "/reset (or /new)", and on the traced install the prompt was
// ~32,000 tokens against a 204,800-token window: nowhere near too large. The
// runtime had resolved the model's max COMPLETION tokens (32,768) as its context
// budget, started compacting at 32,106, and could not free anything because tool
// definitions were 50,405 bytes of every prompt and compaction cannot reach
// those. `/reset` clears the one part that was never the problem.

describe('runFailureText — a context-overflow label', () => {
  const RAW =
    'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.'

  it('explains the likely cause instead of repeating the label', () => {
    const text = runFailureText(RAW, 'openclaw')
    expect(text).not.toContain('/reset')
    expect(text).not.toContain('prompt too large')
    expect(text).toMatch(/context-window setting/i)
    expect(text).toMatch(/tool definitions/i)
  })

  it('says plainly that a fresh session does not fix the cause', () => {
    expect(runFailureText(RAW, 'openclaw')).toMatch(/clears the conversation but not the cause/i)
  })

  it('catches the phrasings other providers use for the same condition', () => {
    for (const raw of [
      'prompt is too long: 210000 tokens > 200000 maximum',
      "This model's maximum context length is 32768 tokens",
      'Please reduce the length of the messages',
    ]) {
      expect(runFailureText(raw, 'openclaw')).toMatch(/context-window setting/i)
    }
  })

  it('leaves an unrelated failure verbatim, so real errors still reach the user', () => {
    expect(runFailureText('ECONNREFUSED 127.0.0.1:18789', 'openclaw')).toBe(
      'The run failed: ECONNREFUSED 127.0.0.1:18789',
    )
  })
})
