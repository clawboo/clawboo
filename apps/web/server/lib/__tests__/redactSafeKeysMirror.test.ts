// The display mask (@clawboo/logger) and the storage scrub (@clawboo/db) each
// keep a list of keys that contain a secret-looking word but are known to be
// safe: token counts and the author fields. The two lists must hold the same
// keys. If they drift, a field is readable on one boundary and masked on the
// other: shown by the API but stored as `[REDACTED]` for good, or stored
// readable and then shown as the mask. This lives in apps/web because only
// apps/web depends on both packages.

import { describe, expect, it } from 'vitest'

import { scrubSafeKeys, scrubSecrets } from '@clawboo/db'
import { redactionSafeKeys, redactObject } from '@clawboo/logger'

describe('safe keys: display mask and storage scrub', () => {
  it('hold the same keys, author fields included', () => {
    expect(redactionSafeKeys()).toEqual(scrubSafeKeys())
    expect(scrubSafeKeys()).toEqual(
      expect.arrayContaining(['author', 'authoragentid', 'authors', 'authortype']),
    )
  })

  it('keep every listed author key readable through both layers', () => {
    const authorKeys = scrubSafeKeys().filter((k) => k.startsWith('author'))
    expect(authorKeys.length).toBeGreaterThan(0)
    for (const key of authorKeys) {
      const record = { [key]: 'value' }
      expect(scrubSecrets(record)).toEqual(record)
      expect(redactObject(record)).toEqual(record)
    }
  })

  it('hand out copies, so a caller cannot widen what is let through', () => {
    const copy = scrubSafeKeys()
    copy.push('authorization')
    redactionSafeKeys().push('authorization')
    expect(scrubSafeKeys()).not.toContain('authorization')
    expect(redactionSafeKeys()).not.toContain('authorization')
    expect(scrubSecrets({ authorization: 'Basic abc' })).not.toEqual({ authorization: 'Basic abc' })
    expect(redactObject({ authorization: 'Basic abc' })).not.toEqual({ authorization: 'Basic abc' })
  })
})
