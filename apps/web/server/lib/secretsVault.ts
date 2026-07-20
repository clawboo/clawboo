// Encrypted credential vault for clawboo's OWN runtime/provider API keys.
//
// AES-256-GCM, encrypting each value at rest under a local master key. This is DEFENSE IN DEPTH: it defeats
// commodity infostealers + accidental backup/sync/share of the vault file (the
// ciphertext is useless without the separate master key) and casual viewing. It
// does NOT protect against a process running as the user — that process can read
// the master key or grab the decrypted value from memory / the spawned child's
// env. No local-key scheme can; an OS keychain wouldn't either (the key still
// reaches the child process). The richer multi-key / per-team model is a
// documented future seam; this ships one value per env-var, server-wide.
//
// Storage — all under clawboo's OWN dir (`resolveClawbooDir()`), never OpenClaw's:
//   <clawbooDir>/secrets/master.key         32-byte key, base64, mode 0600
//   <clawbooDir>/secrets/runtime-keys.json  { [envVar]: { iv, tag, ciphertext } }
//
// Key + ciphertext are COLOCATED under secrets/ by design: a local-first, single-
// user tool has no daemon or keychain, and the only reader able to reach the key
// (a process running as you) can already read the plaintext elsewhere (memory, the
// child env, ~/.openclaw/.env). The encryption's benefit is against the CIPHERTEXT-
// FILE-ALONE case (infostealer / accidental backup-sync-share of runtime-keys.json).
// For true at-rest key/ciphertext SEPARATION, set `CLAWBOO_SECRETS_MASTER_KEY` from
// a source OUTSIDE ~/.clawboo (e.g. `CLAWBOO_SECRETS_MASTER_KEY=$(cat ~/.config/…)`
// or a secret manager) — that override seam already exists; no keychain needed.
//
// `CLAWBOO_SECRETS_MASTER_KEY` overrides the on-disk key (32-byte base64 /
// 64-char hex / raw 32-char). Runtime-key resolution, highest priority first:
//   process.env[envVar]  →  the vault (decrypt)  →  OpenClaw's ~/.openclaw/.env
//
// SECURITY INVARIANTS (load-bearing; covered by secretsVault.test.ts):
//   - A secret VALUE is NEVER logged, NEVER returned in an HTTP response body,
//     NEVER written to SQLite / audit / obs. It flows ONLY into a spawned
//     process's env (the runtime drivers).
//   - The vault file holds ciphertext only (safe to read); the master-key file
//     is 0600 inside a 0700 dir.
//   - A wrong/rotated/lost master key fails CLOSED (returns null), never throws
//     into a request path or leaks partial plaintext.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { readOpenclawEnvVar, resolveClawbooDir } from '@clawboo/config'

interface EncryptedValue {
  iv: string
  tag: string
  ciphertext: string
}

type Vault = Record<string, EncryptedValue>

function secretsDir(): string {
  return path.join(resolveClawbooDir(), 'secrets')
}
function masterKeyPath(): string {
  return path.join(secretsDir(), 'master.key')
}
function vaultPath(): string {
  return path.join(secretsDir(), 'runtime-keys.json')
}

/** The on-disk vault locations, for the boot probe's perms check. The probe is the
 *  one read-only consumer that needs the paths without touching secret values. */
export function getVaultPaths(): { dir: string; masterKey: string; vault: string } {
  return { dir: secretsDir(), masterKey: masterKeyPath(), vault: vaultPath() }
}

/** Accept a 32-byte key supplied as 64 hex chars, base64, or a raw 32-char string. */
function decodeMasterKey(raw: string): Buffer | null {
  const text = raw.trim()
  if (text.length === 0) return null

  // 64 hexadecimal characters encode the 32 raw key bytes.
  if (text.length === 64 && /^[0-9a-fA-F]+$/.test(text)) {
    return Buffer.from(text, 'hex')
  }
  // A literal 32-character key — exactly 32 bytes once UTF-8 encoded.
  if (Buffer.byteLength(text, 'utf8') === 32) {
    return Buffer.from(text, 'utf8')
  }
  // Otherwise treat it as base64, accepting only a clean 32-byte decode.
  const fromBase64 = Buffer.from(text, 'base64')
  return fromBase64.length === 32 ? fromBase64 : null
}

function ensureSecretsDir(): string {
  const dir = secretsDir()
  mkdirSync(dir, { recursive: true })
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* best effort — e.g. Windows, where POSIX modes are advisory */
  }
  return dir
}

function loadOrCreateMasterKey(): Buffer {
  const fromEnv = process.env['CLAWBOO_SECRETS_MASTER_KEY']
  if (fromEnv && fromEnv.trim().length > 0) {
    const decoded = decodeMasterKey(fromEnv)
    if (!decoded) {
      throw new Error(
        'CLAWBOO_SECRETS_MASTER_KEY must be a 32-byte key — supply it as base64, 64 hexadecimal characters, or a 32-character string.',
      )
    }
    return decoded
  }

  const keyPath = masterKeyPath()
  if (existsSync(keyPath)) {
    const decoded = decodeMasterKey(readFileSync(keyPath, 'utf8'))
    if (!decoded) throw new Error(`Unreadable clawboo master key file at ${keyPath}`)
    return decoded
  }

  ensureSecretsDir()
  const generated = randomBytes(32)
  writeFileSync(keyPath, generated.toString('base64'), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(keyPath, 0o600)
  } catch {
    /* best effort */
  }
  return generated
}

function encryptValue(masterKey: Buffer, value: string): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

function decryptValue(masterKey: Buffer, material: EncryptedValue): string {
  const iv = Buffer.from(material.iv, 'base64')
  const tag = Buffer.from(material.tag, 'base64')
  // Enforce the GCM iv (96-bit) + auth-tag (128-bit) lengths. Node's decipher
  // accepts a TRUNCATED tag (which weakens forgery resistance); rejecting any
  // non-standard length keeps the integrity guarantee at full strength. A throw
  // here is caught by getRuntimeSecret → null (fail-closed).
  if (iv.length !== 12 || tag.length !== 16) throw new Error('vault: invalid iv/tag length')
  const ciphertext = Buffer.from(material.ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function isEncryptedValue(v: unknown): v is EncryptedValue {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as EncryptedValue).iv === 'string' &&
    typeof (v as EncryptedValue).tag === 'string' &&
    typeof (v as EncryptedValue).ciphertext === 'string'
  )
}

function readVault(): Vault {
  try {
    const parsed = JSON.parse(readFileSync(vaultPath(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Vault = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEncryptedValue(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeVault(vault: Vault): void {
  ensureSecretsDir()
  const file = vaultPath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

/** Encrypt + persist a runtime secret keyed by its env-var name. */
export function setRuntimeSecret(name: string, value: string): void {
  const masterKey = loadOrCreateMasterKey()
  const vault = readVault()
  vault[name] = encryptValue(masterKey, value)
  writeVault(vault)
}

/** Decrypt + return a runtime secret, or null if absent / undecryptable. */
export function getRuntimeSecret(name: string): string | null {
  const material = readVault()[name]
  if (!material) return null
  try {
    return decryptValue(loadOrCreateMasterKey(), material)
  } catch {
    // Wrong/rotated/lost master key, or a corrupt entry → fail closed.
    return null
  }
}

/** Presence check that never decrypts the value. */
export function hasRuntimeSecret(name: string): boolean {
  return Boolean(readVault()[name])
}

/** Remove a runtime secret. No-op if absent. */
export function deleteRuntimeSecret(name: string): void {
  const vault = readVault()
  if (!(name in vault)) return
  delete vault[name]
  writeVault(vault)
}

/**
 * Resolve a runtime provider key by env-var name, highest priority first:
 *   process.env[envVar]  →  the encrypted vault  →  OpenClaw's ~/.openclaw/.env
 *
 * Returns the plaintext value or null. This is the ONE place a secret VALUE is
 * read; callers put it straight into a spawned process's env — never into a log
 * line, an HTTP response, audit, or SQLite.
 */
export function resolveRuntimeKey(envVar: string): string | null {
  const fromEnv = process.env[envVar]?.trim()
  if (fromEnv) return fromEnv
  const fromVault = getRuntimeSecret(envVar)
  if (fromVault) return fromVault
  return readOpenclawEnvVar(envVar)
}

// ─── Per-runtime disconnect override ─────────────────────────────────────────
// The ambient fallbacks in `resolveRuntimeKey` (a shell-exported var, OpenClaw's
// ~/.openclaw/.env) are the deliberate AUTO-CONNECT chain — an OpenClaw provider
// key auto-satisfies a sibling runtime with zero setup. But they also made the
// Runtimes panel's Disconnect a silent no-op: deleting the vault slot changed
// nothing when the same key still resolved from OpenClaw's .env, so the card
// stayed "Connected" and the runtime kept running. An EXPLICIT user disconnect
// records this per-runtime override; while set, key resolution for THAT runtime
// is vault-only (empty after the disconnect), so status AND runs genuinely lose
// the credential. Cleared by the next connect for the runtime. Stored as a tiny
// sibling file in the secrets dir (no secret material — just runtime ids).

function disconnectedPath(): string {
  return path.join(secretsDir(), 'disconnected-runtimes.json')
}

function readDisconnected(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(readFileSync(disconnectedPath(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out[k] = true
    }
    return out
  } catch {
    return {}
  }
}

/** Record (or clear) the user's explicit disconnect for a runtime. */
export function setRuntimeDisconnected(runtimeId: string, disconnected: boolean): void {
  const flags = readDisconnected()
  if (disconnected) flags[runtimeId] = true
  else delete flags[runtimeId]
  ensureSecretsDir()
  const file = disconnectedPath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(flags, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/** True when the user explicitly disconnected this runtime (and hasn't reconnected). */
export function isRuntimeDisconnected(runtimeId: string): boolean {
  return readDisconnected()[runtimeId] === true
}

/**
 * Runtime-scoped key resolution: the full `resolveRuntimeKey` chain, EXCEPT for
 * a runtime the user explicitly disconnected — then vault-only, so the ambient
 * process-env / OpenClaw-.env fallbacks can't silently re-credential it. Every
 * per-runtime key-assembly site (status, team runs, 1:1 chat, REST runs,
 * routines) resolves through this; the bare `resolveRuntimeKey` remains for
 * non-runtime-scoped reads (OpenClaw provisioning reuse).
 */
export function resolveRuntimeKeyForRuntime(runtimeId: string, envVar: string): string | null {
  if (isRuntimeDisconnected(runtimeId)) return getRuntimeSecret(envVar)
  return resolveRuntimeKey(envVar)
}
