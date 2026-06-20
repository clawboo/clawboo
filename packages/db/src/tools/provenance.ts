// ─── Tool provenance (the signing SEAM) ─────────────────────────────────────
// A descriptor may carry an Ed25519 `provenance` signature. Verification is
// REAL (built on @noble/ed25519, the same primitive device auth uses) but
// ENFORCEMENT is OFF by default — local-first single-user never needs it; a
// future multi-tenant deployment flips `enforce: true` + supplies signer keys.
// This keeps clawboo out of "unsigned forever" without burdening the default.

import * as ed from '@noble/ed25519'

import type { ToolDescriptor } from './types'

// ─── base64url <-> bytes ─────────────────────────────────────────────────────

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return new Uint8Array(Buffer.from(b64 + pad, 'base64'))
}

function bytesToB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The canonical bytes a provenance signature covers: name + description. */
export function provenancePayload(d: Pick<ToolDescriptor, 'name' | 'description'>): Uint8Array {
  return new TextEncoder().encode(`${d.name}\n${d.description}`)
}

export interface ProvenanceVerifyOpts {
  /** OFF by default — the seam is present but does not gate calls. */
  enforce?: boolean
  /** signerId → base64url-encoded 32-byte Ed25519 public key. */
  publicKeys?: Map<string, string>
}

export interface ProvenanceResult {
  ok: boolean
  reason?: string
}

/**
 * Verify a descriptor's provenance. With enforcement OFF (default) this is a
 * no-op pass. With enforcement ON: a missing/unknown/invalid signature fails.
 */
export async function verifyProvenance(
  descriptor: ToolDescriptor,
  opts: ProvenanceVerifyOpts = {},
): Promise<ProvenanceResult> {
  if (!opts.enforce) return { ok: true } // ← the default: seam present, gate off
  const prov = descriptor.provenance
  if (!prov?.signature || !prov.signerId) return { ok: false, reason: 'no-provenance' }
  const pub = opts.publicKeys?.get(prov.signerId)
  if (!pub) return { ok: false, reason: `unknown-signer:${prov.signerId}` }
  try {
    const ok = await ed.verifyAsync(
      b64urlToBytes(prov.signature),
      provenancePayload(descriptor),
      b64urlToBytes(pub),
    )
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch {
    return { ok: false, reason: 'verify-error' }
  }
}

/** Sign a descriptor's payload (base64url private key → base64url signature).
 *  Used by tests and any future signing pipeline. */
export async function signProvenance(
  descriptor: Pick<ToolDescriptor, 'name' | 'description'>,
  privateKeyB64url: string,
): Promise<string> {
  const sig = await ed.signAsync(provenancePayload(descriptor), b64urlToBytes(privateKeyB64url))
  return bytesToB64url(sig)
}

export { b64urlToBytes, bytesToB64url }
