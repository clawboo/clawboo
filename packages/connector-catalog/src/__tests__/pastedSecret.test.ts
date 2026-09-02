// Every case here is a real shape somebody pastes into a token field.

import { describe, expect, it } from 'vitest'

import { cleanPastedSecret } from '../pastedSecret'

describe('cleanPastedSecret', () => {
  it('leaves a clean token exactly as it is', () => {
    expect(cleanPastedSecret('ghp_abc123')).toBe('ghp_abc123')
    expect(cleanPastedSecret('secret_XYZ-9')).toBe('secret_XYZ-9')
  })

  it('strips whitespace and the trailing newline a terminal selection carries', () => {
    expect(cleanPastedSecret('  ghp_abc123\n')).toBe('ghp_abc123')
    expect(cleanPastedSecret('\tghp_abc123 ')).toBe('ghp_abc123')
  })

  it('strips an auth scheme copied out of a curl example', () => {
    expect(cleanPastedSecret('Bearer ghp_abc123')).toBe('ghp_abc123')
    expect(cleanPastedSecret('bearer ghp_abc123')).toBe('ghp_abc123')
    expect(cleanPastedSecret('Token ghp_abc123')).toBe('ghp_abc123')
  })

  it('strips quotes from a shell export or a JSON snippet', () => {
    expect(cleanPastedSecret('"secret_abc"')).toBe('secret_abc')
    expect(cleanPastedSecret("'secret_abc'")).toBe('secret_abc')
    expect(cleanPastedSecret('`secret_abc`')).toBe('secret_abc')
  })

  it('handles the combination, in either nesting order', () => {
    expect(cleanPastedSecret('"Bearer ghp_abc123"')).toBe('ghp_abc123')
    expect(cleanPastedSecret('  \'"ghp_abc123"\'  ')).toBe('ghp_abc123')
  })

  it('leaves an UNMATCHED quote alone, because it may be part of the secret', () => {
    // Removing a lone quote would corrupt a valid token to fix a typo nobody
    // made, and a secret is exactly the value you cannot afford to guess at.
    expect(cleanPastedSecret('"secret_abc')).toBe('"secret_abc')
    expect(cleanPastedSecret('secret_abc"')).toBe('secret_abc"')
  })

  it('leaves a quote INSIDE the value alone', () => {
    expect(cleanPastedSecret('ab"cd')).toBe('ab"cd')
  })

  it('does not eat a token that merely starts with the letters of a scheme', () => {
    // `Bearer` must be followed by whitespace to count as a scheme.
    expect(cleanPastedSecret('Bearertoken123')).toBe('Bearertoken123')
  })

  it('is safe on empty and whitespace-only input', () => {
    expect(cleanPastedSecret('')).toBe('')
    expect(cleanPastedSecret('   ')).toBe('')
  })
})
