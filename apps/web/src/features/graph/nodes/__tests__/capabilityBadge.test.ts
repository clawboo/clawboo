import { describe, expect, it } from 'vitest'

import { capabilityBadge, capabilityReason, humanizeDiagnostic } from '../capabilityBadge'

describe('capabilityBadge: the ladder', () => {
  it('shows NOTHING for a healthy tile', () => {
    // Never-ran is not broken. A badge on every healthy tile is a badge nobody reads.
    expect(capabilityBadge({})).toBeNull()
    expect(capabilityBadge({ health: 'ok', available: true, enabled: true })).toBeNull()
    expect(capabilityBadge({ health: 'unknown' })).toBeNull()
  })

  it('ranks a revoked grant above everything else', () => {
    expect(
      capabilityBadge({ grantState: 'revoked', health: 'needs-auth', available: false })?.kind,
    ).toBe('revoked')
    expect(capabilityBadge({ grantState: 'expired' })?.kind).toBe('revoked')
  })

  it('ranks suspended above health', () => {
    expect(capabilityBadge({ grantState: 'suspended', health: 'drift' })?.kind).toBe('suspended')
  })

  it('ranks DRIFT above needs-auth', () => {
    // Re-authing a rug-pulled server is the wrong move, so drift must not be
    // masked by the friendlier "just sign in" state.
    expect(capabilityBadge({ health: 'drift' })?.kind).toBe('drift')
    expect(capabilityBadge({ health: 'needs-auth' })?.kind).toBe('needs-auth')
  })

  it('ranks needs-auth above a plain unavailable', () => {
    expect(capabilityBadge({ health: 'needs-auth', available: false })?.kind).toBe('needs-auth')
  })

  it('distinguishes "you turned it off" from "it cannot run"', () => {
    // Two different dialects on purpose: disabled is a CHOICE, unavailable is a
    // CONDITION, and collapsing them is what made a pending-auth connector
    // render as fully normal on the graph.
    expect(capabilityBadge({ enabled: false })?.kind).toBe('disabled')
    expect(capabilityBadge({ available: false })?.kind).toBe('unavailable')
  })

  it('treats error and degraded as unavailable', () => {
    expect(capabilityBadge({ health: 'error' })?.kind).toBe('unavailable')
    expect(capabilityBadge({ health: 'degraded' })?.kind).toBe('unavailable')
  })

  it('pulses ONLY for states waiting on a human', () => {
    expect(capabilityBadge({ health: 'needs-auth' })?.pulse).toBe(true)
    expect(capabilityBadge({ health: 'drift' })?.pulse).toBe(true)
    expect(capabilityBadge({ enabled: false })?.pulse).toBe(false)
    expect(capabilityBadge({ available: false })?.pulse).toBe(false)
    expect(capabilityBadge({ grantState: 'suspended' })?.pulse).toBe(false)
  })

  it('gives every badge a human label and a colour token', () => {
    for (const input of [
      { grantState: 'revoked' as const },
      { grantState: 'suspended' as const },
      { health: 'drift' as const },
      { health: 'needs-auth' as const },
      { available: false },
      { enabled: false },
    ]) {
      const badge = capabilityBadge(input)
      expect(badge).not.toBeNull()
      expect(badge?.label.length).toBeGreaterThan(0)
      expect(badge?.color).toMatch(/^var\(--/)
    }
  })
})

describe('humanizeDiagnostic', () => {
  it('splits a coded diagnostic into kind and subject', () => {
    expect(humanizeDiagnostic('auth-missing:openai')).toBe('auth missing: openai')
    expect(humanizeDiagnostic('env-missing:NOTION_TOKEN')).toBe('env missing: NOTION_TOKEN')
  })

  it('degrades to the raw code rather than dropping an unknown one', () => {
    // The diagnostic vocabulary is open (each source mints its own), so a
    // lookup table would silently swallow anything it had not been taught.
    expect(humanizeDiagnostic('something-new')).toBe('something new')
  })

  it('keeps a subject containing a colon intact', () => {
    expect(humanizeDiagnostic('plugin-disabled:a:b')).toBe('plugin disabled: a:b')
  })
})

describe('capabilityReason', () => {
  it('is null when there is nothing to say', () => {
    expect(capabilityReason({ badge: null })).toBeNull()
  })

  it('surfaces the diagnostics the graph used to throw away', () => {
    const badge = capabilityBadge({ available: false })
    const reason = capabilityReason({ badge, diagnostics: ['auth-missing:openai'] })
    expect(reason).toContain('Unavailable')
    expect(reason).toContain('auth missing: openai')
  })

  it('renders the source-supplied hint VERBATIM, and last', () => {
    // The hint comes from the owning runtime, so the graph must never paraphrase
    // it into a per-runtime string of its own.
    const badge = capabilityBadge({ health: 'needs-auth' })
    const reason = capabilityReason({ badge, hint: 'pending auth: run `codex login`' })
    expect(reason?.endsWith('pending auth: run `codex login`')).toBe(true)
  })

  it('includes healthDetail between the badge and the diagnostics', () => {
    const badge = capabilityBadge({ health: 'drift' })
    const reason = capabilityReason({
      badge,
      healthDetail: 'tool list changed',
      diagnostics: ['x'],
    })
    expect(reason).toBe('Changed since you approved it · tool list changed · x')
  })

  it('can produce a reason with no badge (diagnostics only)', () => {
    expect(capabilityReason({ badge: null, diagnostics: ['env-missing:FOO'] })).toBe(
      'env missing: FOO',
    )
  })
})
