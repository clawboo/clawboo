import { describe, expect, it } from 'vitest'

import { parseVerifyCommand, parseVerifyCommandFromVerificationMd } from '../index'

const initSh = (verify: string) =>
  [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    "INSTALL_CMD='pnpm install'",
    `VERIFY_CMD=${verify}`,
    "START_CMD='pnpm dev'",
  ].join('\n')

describe('parseVerifyCommand (init.sh)', () => {
  it('extracts a simple single-quoted command', () => {
    expect(parseVerifyCommand(initSh("'pnpm test'"))).toBe('pnpm test')
  })
  it("reverses the scaffold's bash single-quote escaping", () => {
    // shellQuote("a'b test") => 'a'\''b test'
    expect(parseVerifyCommand(initSh("'a'\\''b test'"))).toBe("a'b test")
  })
  it('returns null for the unconfigured placeholder', () => {
    expect(
      parseVerifyCommand(initSh('\'echo "[init] configure VERIFY_CMD in init.sh"\'')),
    ).toBeNull()
  })
  it('returns null when no VERIFY_CMD line is present', () => {
    expect(parseVerifyCommand('#!/usr/bin/env bash\nset -e\n')).toBeNull()
  })
})

describe('parseVerifyCommandFromVerificationMd', () => {
  it('extracts the backticked verify command', () => {
    expect(
      parseVerifyCommandFromVerificationMd('## Commands\n\n- Verify: `pnpm run check`\n'),
    ).toBe('pnpm run check')
  })
  it('returns null for the placeholder', () => {
    expect(
      parseVerifyCommandFromVerificationMd(
        '- Verify: `echo "[init] configure VERIFY_CMD in init.sh"`',
      ),
    ).toBeNull()
  })
})
