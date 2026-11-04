// Settings an administrator pins for everyone who uses this install.
//
// Admins who deploy Clawboo for a team can pin settings in one file, or in the
// environment variable that matches each key. A pinned setting wins over a
// value saved in the dashboard, which shows it as set by the administrator and
// offers no way to change it.
//
// PRECEDENCE, highest first:
//
//   1. The code's own safety floor. A pin can only make Clawboo more careful. It
//      never unlocks something the code refuses: an in-app update of an install
//      this user cannot write stays refused whatever is pinned.
//   2. The key's environment variable.
//   3. The operator file: `CLAWBOO_OPERATOR_SETTINGS`, else
//      `<CLAWBOO_HOME>/operator.json`.
//   4. A value saved in the dashboard, for the keys it offers. There is one
//      value per install, not per person: anyone using the dashboard changes
//      it for everyone.
//   5. The default.
//
// FAIL-CLOSED. A file that cannot be read or parsed, an unknown key, a value of
// the wrong type, a key that looks like a credential, a world-writable file, or
// a `CLAWBOO_OPERATOR_SETTINGS` naming a file that is not there: every one stops
// the server at startup with a message naming the problem. Starting anyway
// would quietly drop the pins an administrator relies on, such as a disabled
// self-update.
//
// READ-ONLY. Nothing here writes the file. Values saved in the dashboard go to
// the install's database, never back into the administrator's file.
//
// NO SECRETS. The file is meant to be readable by whoever manages the machine,
// and the dashboard shows what it pins. A key that looks like a credential is
// refused, and so is a URL that carries one.
//
// ADDING A KEY: one entry in OPERATOR_KEYS, its row in
// docs/reference/environment-variables.md, and a label in the dashboard's
// DeploymentSettings. Nothing else here changes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

import { getDb } from './db'

/** The variable that points at the operator file, overriding the default location. */
export const OPERATOR_SETTINGS_ENV = 'CLAWBOO_OPERATOR_SETTINGS'
export const OPERATOR_SETTINGS_FILENAME = 'operator.json'

/** Big enough for any real file, small enough that a wrong path cannot stall boot. */
const MAX_FILE_BYTES = 64 * 1024

// ─── The keys ────────────────────────────────────────────────────────────────

interface KindValue {
  /** Env spelling: `1`/`true` or `0`/`false`. File spelling: a JSON boolean. */
  flag: boolean
  /** An http or https URL with no credentials in it. */
  url: string | null
}
type Kind = keyof KindValue

interface KeySpec {
  kind: Kind
  env: string
  /** Whether the dashboard offers a value of its own for this key. */
  userEditable: boolean
}

export const OPERATOR_KEYS = {
  /** No update chip, no in-app update, no registry check. */
  disableSelfUpdate: { kind: 'flag', env: 'CLAWBOO_DISABLE_SELF_UPDATE', userEditable: false },
  /** Do not start the browser connectors on an install that has never had one. */
  disableBrowserAutostart: {
    kind: 'flag',
    env: 'CLAWBOO_DISABLE_BROWSER_AUTOSTART',
    userEditable: true,
  },
  /** Where the marketplace catalog index comes from. */
  catalogIndexUrl: { kind: 'url', env: 'CLAWBOO_CATALOG_INDEX_URL', userEditable: false },
} as const satisfies Record<string, KeySpec>

export type OperatorKey = keyof typeof OPERATOR_KEYS
export type OperatorValue<K extends OperatorKey> = KindValue[(typeof OPERATOR_KEYS)[K]['kind']]

const DEFAULTS: { [K in OperatorKey]: OperatorValue<K> } = {
  disableSelfUpdate: false,
  disableBrowserAutostart: false,
  catalogIndexUrl: null,
}

/** TypeScript resolves DEFAULTS to a plain object, so `DEFAULTS[K]` loses its tie to K. */
function defaultOf<K extends OperatorKey>(key: K): OperatorValue<K> {
  return DEFAULTS[key] as unknown as OperatorValue<K>
}

const KEY_NAMES = Object.keys(OPERATOR_KEYS) as OperatorKey[]

function isOperatorKey(key: string): key is OperatorKey {
  return Object.prototype.hasOwnProperty.call(OPERATOR_KEYS, key)
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

export class OperatorSettingsError extends Error {
  override name = 'OperatorSettingsError'
}

/** Key names that would mean someone is storing a secret in the file. */
const CREDENTIAL_KEY = /token|secret|passw(or)?d|api[-_]?key|credential|private[-_]?key|auth/i
/**
 * Query parameter names that carry a credential in a URL: `token`, `api_key`,
 * `access_key` and any other `*_key`, `auth`, signed-URL signatures.
 */
const CREDENTIAL_PARAM =
  /token|secret|passw(or)?d|api[-_]?key|credential|auth|signature|(^|[-_])key$|^sig$/i

function parseUrl(raw: string, where: string): string {
  const value = raw.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not echoed: a malformed URL can still carry a token.
    throw new OperatorSettingsError(`${where} is not a valid URL. Use an http or https URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OperatorSettingsError(`${where} must be an http or https URL, got "${url.protocol}".`)
  }
  // Checked by NAME, never echoed: the message must not repeat the secret.
  if (url.username || url.password) {
    throw new OperatorSettingsError(
      `${where} must not carry credentials. Remove the user name and password from the URL.`,
    )
  }
  // The parameter is not named: a bare `?<token>` makes the token the name.
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_PARAM.test(name)) {
      throw new OperatorSettingsError(
        `${where} must not carry credentials. Remove the credential from the URL's query string.`,
      )
    }
  }
  return value
}

/** ` (line L, column C)` from a JSON.parse error, or nothing it can trust. */
function jsonErrorPlace(err: unknown): string {
  const message = err instanceof SyntaxError ? err.message : ''
  const m = /line (\d+) column (\d+)/.exec(message)
  return m ? ` (line ${m[1]}, column ${m[2]})` : ''
}

function parseFileValue(kind: Kind, raw: unknown, where: string): boolean | string {
  if (kind === 'flag') {
    if (typeof raw !== 'boolean') {
      throw new OperatorSettingsError(`${where} must be true or false.`)
    }
    return raw
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new OperatorSettingsError(`${where} must be an http or https URL.`)
  }
  return parseUrl(raw, where)
}

/** Unset or empty means "not pinned here", so `VAR=` never pins a value. */
function parseEnvValue(kind: Kind, raw: string | undefined, name: string): boolean | string | null {
  const value = raw?.trim() ?? ''
  if (value === '') return null
  if (kind === 'flag') {
    const lower = value.toLowerCase()
    if (lower === '1' || lower === 'true') return true
    if (lower === '0' || lower === 'false') return false
    throw new OperatorSettingsError(`${name} must be 1 or 0 (or true or false), got "${value}".`)
  }
  return parseUrl(value, name)
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export type PinSource = 'environment' | 'file'

export interface Pin<K extends OperatorKey = OperatorKey> {
  value: OperatorValue<K>
  source: PinSource
}

export type OperatorPins = { [K in OperatorKey]?: Pin<K> }

export interface OperatorFile {
  /** The file that was read, or null when there is none at the default location. */
  path: string | null
  pins: OperatorPins
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~(?=$|[/\\])/, os.homedir()) : p
}

/** Where the operator file is looked for, and whether someone named it explicitly. */
export function operatorFileLocation(env: NodeJS.ProcessEnv = process.env): {
  path: string
  explicit: boolean
} {
  const named = env[OPERATOR_SETTINGS_ENV]?.trim()
  if (named) return { path: path.resolve(expandHome(named)), explicit: true }
  return { path: path.join(resolveClawbooDir(env), OPERATOR_SETTINGS_FILENAME), explicit: false }
}

/**
 * Read and validate the operator file. Throws {@link OperatorSettingsError} on
 * anything it cannot trust; returns no pins when there is no file at the
 * default location.
 */
export function readOperatorFile(env: NodeJS.ProcessEnv = process.env): OperatorFile {
  const { path: file, explicit } = operatorFileLocation(env)
  const label = `Operator settings file ${file}`

  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !explicit) return { path: null, pins: {} }
    if (code === 'ENOENT') {
      throw new OperatorSettingsError(
        `${OPERATOR_SETTINGS_ENV} names ${file}, which does not exist. Fix the path, or unset ${OPERATOR_SETTINGS_ENV}.`,
      )
    }
    throw new OperatorSettingsError(`${label} cannot be read (${code ?? String(err)}).`)
  }
  if (!stat.isFile()) throw new OperatorSettingsError(`${label} is not a file.`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new OperatorSettingsError(`${label} is larger than ${MAX_FILE_BYTES} bytes.`)
  }
  // Anyone on the machine could pin settings through a world-writable file.
  if (process.platform !== 'win32' && (stat.mode & 0o002) !== 0) {
    throw new OperatorSettingsError(
      `${label} can be changed by any user on this machine. Remove write access for others (chmod o-w).`,
    )
  }

  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new OperatorSettingsError(`${label} cannot be read (${code ?? 'unknown error'}).`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    // Only where, never the parser's own message: it quotes the text around
    // the error, which can be a secret someone pasted in.
    throw new OperatorSettingsError(`${label} is not valid JSON${jsonErrorPlace(err)}.`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new OperatorSettingsError(`${label} must hold a JSON object.`)
  }

  const pins: Partial<Record<OperatorKey, Pin>> = {}
  for (const [key, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new OperatorSettingsError(
        `${label} must not hold secrets. Remove "${key}" and keep credentials in the vault or the environment.`,
      )
    }
    if (!isOperatorKey(key)) {
      throw new OperatorSettingsError(
        `${label} has an unknown key "${key}". Supported keys: ${KEY_NAMES.join(', ')}.`,
      )
    }
    pins[key] = {
      value: parseFileValue(OPERATOR_KEYS[key].kind, raw, `"${key}" in ${file}`),
      source: 'file',
    }
  }
  return { path: file, pins: pins as OperatorPins }
}

/** The pins the environment sets. Throws on a value it cannot read. */
export function readOperatorEnv(env: NodeJS.ProcessEnv = process.env): OperatorPins {
  const pins: Partial<Record<OperatorKey, Pin>> = {}
  for (const key of KEY_NAMES) {
    const spec = OPERATOR_KEYS[key]
    const value = parseEnvValue(spec.kind, env[spec.env], spec.env)
    if (value !== null) pins[key] = { value, source: 'environment' }
  }
  return pins as OperatorPins
}

// The file is read once per location, the way the rest of the server's
// configuration is read once. The environment is read on every lookup: it does
// not change while the server runs, and reading it live keeps a test that stubs
// one variable honest.
let fileCache: { location: string; file: OperatorFile } | null = null

function cachedFile(env: NodeJS.ProcessEnv = process.env): OperatorFile {
  const location = operatorFileLocation(env).path
  if (fileCache?.location !== location) fileCache = { location, file: readOperatorFile(env) }
  return fileCache.file
}

/**
 * Validate everything at startup. Throws {@link OperatorSettingsError}; the
 * server turns that into a refusal to start.
 */
export function initOperatorSettings(env: NodeJS.ProcessEnv = process.env): {
  file: string | null
  pins: OperatorPins
} {
  const envPins = readOperatorEnv(env)
  fileCache = null
  const file = cachedFile(env)
  return { file: file.path, pins: { ...file.pins, ...envPins } }
}

/** Forget the file read at startup, so the next lookup reads it again. Tests. */
export function resetOperatorSettings(): void {
  fileCache = null
}

/** The pin for one key, if the environment or the file sets one. */
export function operatorPin<K extends OperatorKey>(key: K): Pin<K> | undefined {
  return readOperatorEnv()[key] ?? cachedFile().pins[key]
}

// ─── A value saved in the dashboard ──────────────────────────────────────────

const userSettingKey = (key: OperatorKey): string => `user-setting:${key}`

export class PinnedSettingError extends Error {
  override name = 'PinnedSettingError'
}

function readUserValue<K extends OperatorKey>(db: ClawbooDb, key: K): OperatorValue<K> | undefined {
  const raw = getSetting(db, userSettingKey(key))
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    const kind = OPERATOR_KEYS[key].kind
    if (kind === 'flag' && typeof parsed === 'boolean') return parsed as OperatorValue<K>
    if (kind === 'url' && typeof parsed === 'string') return parsed as OperatorValue<K>
  } catch {
    // A value this build cannot read is no choice at all.
  }
  return undefined
}

/**
 * Save a value from the dashboard, for the whole install. Refused for a key the
 * dashboard does not offer, and for one an administrator has pinned: the value
 * would never apply, and saving it would look like it had.
 */
export function saveUserSetting<K extends OperatorKey>(
  key: K,
  value: OperatorValue<K>,
  db: ClawbooDb = getDb(),
): void {
  if (!OPERATOR_KEYS[key].userEditable) {
    throw new PinnedSettingError(`${key} can only be set by an administrator.`)
  }
  if (operatorPin(key)) {
    throw new PinnedSettingError(`${key} is set by your administrator.`)
  }
  setSetting(db, userSettingKey(key), JSON.stringify(value))
}

// ─── The effective value ─────────────────────────────────────────────────────

export interface EffectiveSetting<K extends OperatorKey = OperatorKey> {
  key: K
  value: OperatorValue<K>
  source: PinSource | 'user' | 'default'
  /** Set by an administrator, so the dashboard cannot change it. */
  pinned: boolean
  userEditable: boolean
  env: string
}

/**
 * The value a key takes right now, below the code's own safety floor, which the
 * caller applies (see the header).
 */
export function effectiveSetting<K extends OperatorKey>(
  key: K,
  db?: ClawbooDb,
): EffectiveSetting<K> {
  const spec = OPERATOR_KEYS[key]
  const base = { key, userEditable: spec.userEditable, env: spec.env }
  const pin = operatorPin(key)
  if (pin) return { ...base, value: pin.value, source: pin.source, pinned: true }
  if (spec.userEditable) {
    const own = readUserValue(db ?? getDb(), key)
    if (own !== undefined) return { ...base, value: own, source: 'user', pinned: false }
  }
  return { ...base, value: defaultOf(key), source: 'default', pinned: false }
}

/** Every key, for the dashboard. */
export function listEffectiveSettings(db?: ClawbooDb): EffectiveSetting[] {
  return KEY_NAMES.map((key) => effectiveSetting(key, db))
}

export function parseOperatorKey(key: string): OperatorKey | null {
  return isOperatorKey(key) ? key : null
}
