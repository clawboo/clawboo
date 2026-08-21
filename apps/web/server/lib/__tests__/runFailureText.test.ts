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
