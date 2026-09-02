// What a failed Gateway run says when it said nothing else.
//
// The wording is a COPY of the server's `runFailureText` generic arm, because
// that module reaches server-only code and `apps/web/src` may not import from
// `apps/web/server`.
//
// NOT A REAL PARITY TEST, and worth being honest about: the import boundary runs
// both ways, so neither side can assert against the other's function. What holds
// them together is that each side pins the same literal independently, here and
// in `apps/web/server/lib/__tests__/runFailureText.test.ts:37`. Changing one
// sentence breaks one of the two tests, which is the signal to change both.

import { describe, expect, it } from 'vitest'

import { gatewayRunFailureText } from '../useGatewayEvents'

describe('gatewayRunFailureText', () => {
  it('reports the reason the runtime gave, worded like the server does', () => {
    // apps/web/server/lib/runFailureText.ts:43 — `The run failed: ${...}`
    expect(gatewayRunFailureText('rate limited')).toBe('The run failed: rate limited')
  })

  it('says what to do when the runtime gave no reason at all', () => {
    // The Gateway usually sends no message, so this is the COMMON case, not the
    // edge one. "unknown error" would be honest and useless; this is the
    // sentence the team drain already uses (runFailureText.ts:20-21).
    const noReason = gatewayRunFailureText(null)
    expect(noReason).toContain('try sending again')
    expect(noReason).not.toContain('unknown error')
  })

  it('treats blank and whitespace as no reason rather than printing an empty one', () => {
    // `The run failed: ` with nothing after the colon reads as a rendering bug.
    expect(gatewayRunFailureText('')).toBe(gatewayRunFailureText(null))
    expect(gatewayRunFailureText('   ')).toBe(gatewayRunFailureText(undefined))
  })
})

// ── The context-overflow arm ────────────────────────────────────────────────
// This is the arm an OpenClaw chat actually reaches, and it is why the parity
// note above matters. The server copy grew this branch first and this test did
// NOT break, because the shared generic sentence was untouched: pinning only the
// wording they have in common misses a branch added to one side. So both
// sentences are pinned now, on both sides.

describe('gatewayRunFailureText — a context-overflow label', () => {
  const RAW =
    'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.'

  it('explains the likely cause instead of repeating the label', () => {
    // apps/web/server/lib/__tests__/runFailureText.test.ts pins the same sentence.
    const text = gatewayRunFailureText(RAW)
    expect(text).not.toContain('/reset')
    expect(text).not.toContain('prompt too large')
    expect(text).toMatch(/context-window setting/i)
    expect(text).toMatch(/tool definitions/i)
    expect(text).toMatch(/clears the conversation but not the cause/i)
  })

  it('catches the phrasings other providers use for the same condition', () => {
    for (const raw of [
      'prompt is too long: 210000 tokens > 200000 maximum',
      "This model's maximum context length is 32768 tokens",
      'Please reduce the length of the messages',
    ]) {
      expect(gatewayRunFailureText(raw)).toMatch(/context-window setting/i)
    }
  })

  it('leaves an unrelated failure verbatim, so real errors still reach the user', () => {
    expect(gatewayRunFailureText('ECONNREFUSED 127.0.0.1:18789')).toBe(
      'The run failed: ECONNREFUSED 127.0.0.1:18789',
    )
  })
})
