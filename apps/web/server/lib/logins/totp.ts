// Time-based one-time codes (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second
// steps, 6 digits, which is what a site's "set up an authenticator app" QR code
// means unless it says otherwise. The code goes into the page with the rest of
// the login and nowhere else.

import { createHmac } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(secret: string): Buffer | null {
  const clean = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) return null
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The code for `atMs`, or null when the secret is not base32. */
export function totpCode(secret: string, atMs: number = Date.now()): string | null {
  const key = base32Decode(secret)
  if (!key || key.length === 0) return null
  const counter = Math.floor(atMs / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  msg.writeUInt32BE(counter >>> 0, 4)
  const mac = createHmac('sha1', key).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)
  return String(bin % 1_000_000).padStart(6, '0')
}
