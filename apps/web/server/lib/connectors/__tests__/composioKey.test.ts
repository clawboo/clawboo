// The shapes a key really arrives in.
//
// The first case is the one that shipped broken: Composio's dashboard presents
// the key as an assignment, so the whole line is what lands on the clipboard.

import { describe, expect, it } from 'vitest'

import { explainKeyProblem, readComposioKey } from '../composioKey'

const KEY = 'ak_A1b2C3d4E5f6G7h8i9j0'

describe('readComposioKey', () => {
  it('takes the key out of the line the dashboard shows', () => {
    expect(readComposioKey(`COMPOSIO_API_KEY=${KEY}`).key).toBe(KEY)
  })

  it('accepts the same line with export, spaces and quotes', () => {
    expect(readComposioKey(`export COMPOSIO_API_KEY = "${KEY}"`).key).toBe(KEY)
    expect(readComposioKey(`COMPOSIO_API_KEY='${KEY}'`).key).toBe(KEY)
  })

  it('accepts a bare key, however it was copied', () => {
    expect(readComposioKey(KEY).key).toBe(KEY)
    expect(readComposioKey(`  ${KEY}\n`).key).toBe(KEY)
    expect(readComposioKey(`"${KEY}"`).key).toBe(KEY)
  })

  it('names the login key rather than calling it invalid', () => {
    const reading = readComposioKey('uak_A1b2C3d4E5f6G7h8i9j0')
    expect(reading.key).toBeNull()
    expect(reading.problem).toBe('user-key')
    expect(explainKeyProblem('user-key')).toContain('ak_')
  })

  it('refuses anything else, including a truncated key', () => {
    expect(readComposioKey('').problem).toBe('empty')
    expect(readComposioKey('   ').problem).toBe('empty')
    expect(readComposioKey('hello').problem).toBe('unrecognised')
    expect(readComposioKey('ak_short').problem).toBe('unrecognised')
  })

  it('leaves a key alone rather than splitting it on its own characters', () => {
    // The assignment rule must not fire on a value that merely contains an
    // equals sign, or it would silently truncate a key it did not understand.
    expect(readComposioKey('ak_A1b2=C3d4E5f6G7h8i9j0').problem).toBe('unrecognised')
  })

  it('explains every problem it can report', () => {
    for (const problem of ['empty', 'user-key', 'unrecognised'] as const) {
      expect(explainKeyProblem(problem).length).toBeGreaterThan(0)
    }
  })
})
