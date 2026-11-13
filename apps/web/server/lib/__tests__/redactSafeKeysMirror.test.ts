// The display mask (@clawboo/logger) and the storage scrub (@clawboo/db) each
// keep a list of keys that contain a secret-looking word but are known to be
// safe: token counts and the author fields. The two lists must hold the same
// keys. If they drift, a field is readable on one boundary and masked on the
// other: shown by the API but stored as `[REDACTED]` for good, or stored
// readable and then shown as the mask. This lives in apps/web because only
// apps/web depends on both packages.

import { describe, expect, it } from 'vitest'

import { SCRUB_SAFE_KEYS, scrubSecrets } from '@clawboo/db'
import { REDACTION_SAFE_KEYS, redactObject } from '@clawboo/logger'

const sorted = (keys: ReadonlySet<string>): string[] => [...keys].sort()

describe('safe keys: display mask and storage scrub', () => {
  it('hold the same keys, author fields included', () => {
    expect(sorted(REDACTION_SAFE_KEYS)).toEqual(sorted(SCRUB_SAFE_KEYS))
    expect(sorted(SCRUB_SAFE_KEYS)).toEqual(
      expect.arrayContaining(['author', 'authoragentid', 'authors', 'authortype']),
    )
  })

  it('keep every listed author key readable through both layers', () => {
    const authorKeys = sorted(SCRUB_SAFE_KEYS).filter((k) => k.startsWith('author'))
    expect(authorKeys.length).toBeGreaterThan(0)
    for (const key of authorKeys) {
      const record = { [key]: 'value' }
      expect(scrubSecrets(record)).toEqual(record)
      expect(redactObject(record)).toEqual(record)
    }
  })
})
