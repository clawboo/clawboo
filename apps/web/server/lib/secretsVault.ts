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
// plus two tiny plaintext flag files with no secret material (see their sections):
//   disconnected-runtimes.json, keyless-providers.json
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
//     process's env (the runtime drivers) and, inside this process, to the
//     storage scrub that masks it (see "Saved values for the storage scrub").
//   - The vault file holds ciphertext only (safe to read); the master-key file
//     is 0600 inside a 0700 dir.
//   - A wrong/rotated/lost master key fails CLOSED (returns null), never throws
//     into a request path or leaks partial plaintext.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { readOpenclawEnvVar, resolveClawbooDir } from '@clawboo/config'
import { MIN_KNOWN_SECRET_LENGTH, registerKnownSecretSource } from '@clawboo/db'

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

/** The master key from the environment or its file, or null when there is
 *  none yet. Never creates one. Throws on a key that cannot be decoded. */
function loadExistingMasterKey(): Buffer | null {
  const fromEnv = process.env['CLAWBOO_SECRETS_MASTER_KEY']
  if (fromEnv && fromEnv.trim().length > 0) {
    const decoded = decodeMasterKey(fromEnv)
    if (!decoded) throw new Error('CLAWBOO_SECRETS_MASTER_KEY is not a 32-byte key')
    return decoded
  }
  const keyPath = masterKeyPath()
  if (!existsSync(keyPath)) return null
  const decoded = decodeMasterKey(readFileSync(keyPath, 'utf8'))
  if (!decoded) throw new Error(`Unreadable clawboo master key file at ${keyPath}`)
  return decoded
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

/** The vault, `{}` when there is no vault file yet, or null when it could not be
 *  read or parsed. */
function tryReadVault(): Vault | null {
  let raw: string
  try {
    raw = readFileSync(vaultPath(), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Vault = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isEncryptedValue(v)) out[k] = v
    }
    return out
  } catch {
    return null
  }
}

function readVault(): Vault {
  return tryReadVault() ?? {}
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

// ─── Saved values for the storage scrub ──────────────────────────────────────
// The storage scrub in @clawboo/db masks credentials by shape, and a supported
// key of another shape (Groq's `gsk_…`, a Mistral key, xAI's `xai-…`) matches
// none of its patterns. This module knows the exact values, so it lends them:
// ONE in-memory set, decrypted from the vault on first use and marked stale on
// every write or removal so the next scrub rebuilds it. The set leaves this module only
// through the source registered below, which the scrub compares against; it is
// never logged, returned by a route, or written anywhere. Values shorter than
// the scrub's minimum are left out of it entirely.
//
// Holding the values in memory changes nothing against the threat model above:
// a process that can read this one's memory can already read the master key.

// A read that fails (a vault file that cannot be parsed, a master key that cannot
// be loaded) is never cached: the next scrub reads again, and until one succeeds
// the scrub keeps the last set this vault lent, so a passing fault can only mask
// more, never less.
let lentValues: { vault: string; values: ReadonlySet<string>; current: boolean } | null = null
const NOTHING_LENT: ReadonlySet<string> = new Set()

// An OAuth slot holds a JSON object. Only its token and secret fields are
// credentials; the client id and the redirect address are ordinary text that
// has to stay readable wherever it is quoted.
const SECRET_FIELD_RE = /token|secret|password|key/i

function secretMaterialOf(plain: string): string[] {
  if (!plain.startsWith('{')) return [plain]
  try {
    const parsed = JSON.parse(plain) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [plain]
    const out: string[] = []
    for (const [field, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && SECRET_FIELD_RE.test(field)) out.push(v)
    }
    return out
  } catch {
    return [plain]
  }
}

/** Every saved value long enough to mask, or null when the vault or its master
 *  key could not be read. */
function readSavedSecretValues(
  opts: { createKey: boolean } = { createKey: true },
): Set<string> | null {
  const vault = tryReadVault()
  if (!vault) return null
  const values = new Set<string>()
  const entries = Object.values(vault)
  if (entries.length === 0) return values
  let masterKey: Buffer
  try {
    const key = opts.createKey ? loadOrCreateMasterKey() : loadExistingMasterKey()
    if (!key) return null
    masterKey = key
  } catch {
    return null
  }
  for (const material of entries) {
    try {
      for (const v of secretMaterialOf(decryptValue(masterKey, material))) {
        if (v.length >= MIN_KNOWN_SECRET_LENGTH) values.add(v)
      }
    } catch {
      /* undecryptable entry: nothing to lend */
    }
  }
  return values
}

function savedSecretValues(): ReadonlySet<string> {
  const file = vaultPath()
  const lent = lentValues?.vault === file ? lentValues : null
  if (lent?.current) return lent.values
  const values = readSavedSecretValues()
  if (!values) return lent?.values ?? NOTHING_LENT
  lentValues = { vault: file, values, current: true }
  return values
}

function markLentValuesStale(): void {
  if (lentValues) lentValues = { ...lentValues, current: false }
}

registerKnownSecretSource(savedSecretValues)

/**
 * Every value that must never be visible to another OS user: each saved key,
 * and the vault's master key (from the environment or its file). For the agent
 * isolation startup check, which looks for these in what the agent user can see
 * of this process. Never creates a master key.
 */
export function secretValuesForExposureCheck(): string[] {
  // Read-only: a vault with entries and no key yet must not get a new key here
  // (that would also make every saved value undecryptable). A vault that cannot
  // be read now falls back to the values last read from it, as lending does.
  const lent = lentValues?.vault === vaultPath() ? lentValues.values : []
  const out = new Set<string>(readSavedSecretValues({ createKey: false }) ?? lent)
  const fromEnv = process.env['CLAWBOO_SECRETS_MASTER_KEY']?.trim()
  if (fromEnv) out.add(fromEnv)
  try {
    const keyPath = masterKeyPath()
    if (existsSync(keyPath)) {
      const fromFile = readFileSync(keyPath, 'utf8').trim()
      if (fromFile) out.add(fromFile)
    }
  } catch {
    /* unreadable: nothing to look for */
  }
  return [...out]
}

/** Encrypt + persist a runtime secret keyed by its env-var name. */
export function setRuntimeSecret(name: string, value: string): void {
  const masterKey = loadOrCreateMasterKey()
  const vault = readVault()
  vault[name] = encryptValue(masterKey, value)
  writeVault(vault)
  markLentValuesStale()
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

/**
 * Whether the vault could be read just now: absent counts as readable (it
 * simply holds nothing), any other failure does not. Lets a caller tell "the
 * key was removed" from "the key could not be read this once".
 */
export function isVaultReadable(): boolean {
  try {
    JSON.parse(readFileSync(vaultPath(), 'utf8'))
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

/** Remove a runtime secret. No-op if absent. */
export function deleteRuntimeSecret(name: string): void {
  const vault = readVault()
  if (!(name in vault)) return
  delete vault[name]
  writeVault(vault)
  markLentValuesStale()
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

// ─── Keyless provider choice ─────────────────────────────────────────────────
// A keyless provider (local Ollama) has nothing to store in the vault, so the
// vault alone can't say whether the user set it up. This records the choice
// itself, per provider: `true` when the user picked it, `false` when they removed
// it, absent when neither (or after a full runtime disconnect, which forgets it).
// The native runtime reads it through `isNativeOllamaConnected`. Stored as a tiny
// sibling file in the secrets dir (no secret material, just provider ids).

function keylessChoicesPath(): string {
  return path.join(secretsDir(), 'keyless-providers.json')
}

function readKeylessChoices(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(readFileSync(keylessChoicesPath(), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Record the user's choice for a keyless provider: `true` = chosen, `false` =
 *  removed (a disconnect, scoped or full), `null` = forget it (no recorded choice). */
export function setKeylessProviderChoice(provider: string, choice: boolean | null): void {
  const choices = readKeylessChoices()
  if (choice === null) delete choices[provider]
  else choices[provider] = choice
  ensureSecretsDir()
  const file = keylessChoicesPath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(choices, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/** The user's recorded choice for a keyless provider, or null when none is recorded. */
export function getKeylessProviderChoice(provider: string): boolean | null {
  return readKeylessChoices()[provider] ?? null
}

/**
 * Runtime-scoped key resolution: the full `resolveRuntimeKey` chain, EXCEPT for
 * a runtime the user explicitly disconnected, which resolves no key at all until
 * it is connected again. Not an ambient one (process env, OpenClaw's .env), and
 * not a vault key it shares with another runtime: its disconnect leaves those in
 * place for the runtimes still using them. Every per-runtime key-assembly site
 * (status, team runs, 1:1 chat, REST runs, routines) resolves through this; the
 * bare `resolveRuntimeKey` remains for non-runtime-scoped reads (OpenClaw
 * provisioning reuse).
 */
export function resolveRuntimeKeyForRuntime(runtimeId: string, envVar: string): string | null {
  if (isRuntimeDisconnected(runtimeId)) return null
  return resolveRuntimeKey(envVar)
}
