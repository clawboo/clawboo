// The Hermes gateway's home and one Hermes profile per Clawboo Hermes agent.
//
// One `hermes gateway` serves every profile under `<gateway home>/profiles/`,
// each at `/p/<profile>/` with its own API key, its own `.env` (provider keys are
// read from there, never from the gateway's environment), its own memory,
// skills, sessions (`state.db`) and scheduled jobs, and its own terminal policy.
// A new profile is served without a restart.
//
// Clawboo owns these files:
//   - the gateway home's `config.yaml` and `.env` (rewritten on every start);
//   - each profile's `.env` (rewritten before every run): its API key, the
//     provider keys of the run, and its working folder (`TERMINAL_CWD`, which
//     Hermes reads per turn; the API has no per-run folder);
//   - in each profile's `config.yaml`: a marked `mcp_servers` block (Clawboo's
//     Tasks, Memory, Tools and TeamChat servers, one stable URL per agent), the
//     `terminal:` keys that would move commands away from the run's folder, and
//     `approvals.mode: manual` when the config sets no approvals of its own;
//   - `auth.json` (a copy of the person's Hermes ChatGPT sign-in), as before.
// Everything else in a profile belongs to Hermes.
//
// Each agent's state used to live in its own Hermes home,
// `<data>/runtimes/hermes/<agent>`. The first time that agent's profile is
// provisioned, the old home is moved into the profile, so its memory, skills and
// sessions carry over. The runner keeps naming the old path as the agent's
// identity home, so the driver reads the agent from it.
//
// Clawboo never writes the person's own `~/.hermes`: it only copies from it.

import { createHmac, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { createLogger } from '@clawboo/logger'
import { parseDocument } from 'yaml'

import {
  agentMkdir,
  agentReadFile,
  agentRemove,
  agentRename,
  agentStat,
  agentWriteFile,
} from '../../agentUser/agentFs'
import {
  mergeClawbooMcpServers,
  seedHermesAuth,
  userHermesConfigPath,
  type HermesMcpServers,
} from '../hermesHome'
import { isAgentUserMode } from '../../agentUser/config'
import { runtimeIdentityHomePath } from '../identityHome'
import { HERMES_PROFILE_RE } from './client'

/** The fixed identity of the gateway's own home among the per-agent homes. Its
 *  leading underscore keeps it from ever reading as a Hermes profile name. */
export const HERMES_GATEWAY_HOME_ID = '_gateway'

/** Where the supervised gateway keeps its home (Hermes's `HERMES_HOME`). */
export function hermesGatewayHome(env: NodeJS.ProcessEnv = process.env): string {
  return runtimeIdentityHomePath('hermes', HERMES_GATEWAY_HOME_ID, env)
}

export function hermesProfileDir(gatewayHome: string, profile: string): string {
  if (!HERMES_PROFILE_RE.test(profile)) throw new Error(`not a Hermes profile name: ${profile}`)
  return path.join(gatewayHome, 'profiles', profile)
}

const log = createLogger('hermes-profiles')

/** Profile names Hermes keeps for itself. */
const RESERVED = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo'])

/**
 * The Hermes profile of a Clawboo agent, from the agent's identity home (whose
 * last segment is the agent id made path-safe). Hermes accepts lowercase letters,
 * digits, `_` and `-`, up to 64; a segment that is already that, lowercase, is
 * kept readable as `cb-<id>`, and any other is hashed, so two ids that differ
 * only in case never share a profile. Throwaway runs get `cbtmp-<random>`.
 */
export function hermesProfileName(identityHome: string): string {
  const segment = path.basename(identityHome)
  if (/^[a-z0-9][a-z0-9_-]{0,60}$/.test(segment)) return `cb-${segment}`
  const hash = createHmac('sha256', 'clawboo-hermes-profile').update(segment).digest('hex')
  return `cb-h${hash.slice(0, 32)}`
}

export function throwawayProfileName(): string {
  return `cbtmp-${randomBytes(8).toString('hex')}`
}

/** Whether a profile name is one Clawboo made (so its folder is Clawboo's to manage). */
export function isClawbooProfile(name: string): boolean {
  return HERMES_PROFILE_RE.test(name) && !RESERVED.has(name) && /^cb(?:tmp)?-/.test(name)
}

/** An API key derived for one profile (or the gateway root) from the vault's
 *  master key. Hermes wants 16 characters or more; this is 64 hex. */
export function derivedHermesKey(masterKey: string, label: string): string {
  return createHmac('sha256', masterKey).update(`hermes-api-server:${label}`).digest('hex')
}

/** Every character Hermes's `.env` readers end a line at (Python's
 *  `str.splitlines`), and NUL. */
// eslint-disable-next-line no-control-regex
const ENV_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/
// eslint-disable-next-line no-control-regex
const ENV_REFUSED = /[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029\0]/

/**
 * One `.env` line, read back the same by both of Hermes's readers (its own
 * profile-scope parser and python-dotenv): always double quotes, with `\\` and
 * `"` escaped, which both undo. Refused: a value with a line break (Hermes would
 * read the rest as another variable), and one with `${`, which python-dotenv
 * expands inside either kind of quotes.
 */
export function envLine(name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`not an env var name: ${name}`)
  if (ENV_REFUSED.test(value)) throw new Error(`${name} holds a line break`)
  if (value.includes('${')) throw new Error(`${name} cannot be written to a .env file as it is`)
  return `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** A `.env` file's lines, split where Hermes splits them. */
function envLines(body: string): string[] {
  return body.split(ENV_LINE_BREAK)
}

const HEADER = '# Written by Clawboo. It is rewritten'

/** The gateway home's `config.yaml`: one gateway for every profile, the API
 *  server's run cap, no update checks against a tree that is not a git checkout,
 *  no plugin update checks, commands on this computer. */
export function renderGatewayConfig(opts: { maxConcurrentRuns?: number } = {}): string {
  return [
    `${HEADER} every time Clawboo starts the Hermes gateway.`,
    'gateway:',
    '  multiplex_profiles: true',
    '  api_server:',
    `    max_concurrent_runs: ${opts.maxConcurrentRuns ?? 10}`,
    'updates:',
    '  check: false',
    'plugins:',
    '  auto_update_check_hours: 0',
    'terminal:',
    '  backend: local',
    '',
  ].join('\n')
}

/** The gateway home's `.env`: the API server on loopback with its key. Hermes
 *  turns the API server on when it finds a usable key; nothing else is here, so
 *  no chat channel can turn on from this file. */
export function renderGatewayEnv(opts: { port: number; key: string }): string {
  return [
    `${HEADER} every time Clawboo starts the Hermes gateway.`,
    envLine('API_SERVER_HOST', '127.0.0.1'),
    envLine('API_SERVER_PORT', String(opts.port)),
    envLine('API_SERVER_KEY', opts.key),
    '',
  ].join('\n')
}

/** The `.env` names Clawboo writes in a profile. A line with any other name was
 *  added by someone else (a key for a provider Clawboo does not connect, say) and
 *  is kept. */
export const MANAGED_PROFILE_ENV = new Set([
  'API_SERVER_KEY',
  'TERMINAL_ENV',
  'TERMINAL_CWD',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
])

const ENV_NAME_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const KEPT_HEADER = '# Kept as they were:'

/** A profile's `.env`: its key, where its commands run, the provider keys, then
 *  the lines someone else added to the file before (`previous`). */
export function renderProfileEnv(opts: {
  key: string
  cwd: string | null
  providerEnv: Record<string, string>
  previous?: string | null
}): string {
  const lines = [`${HEADER} before each run of this agent.`, envLine('API_SERVER_KEY', opts.key)]
  lines.push(envLine('TERMINAL_ENV', 'local'))
  if (opts.cwd) lines.push(envLine('TERMINAL_CWD', opts.cwd))
  for (const [name, value] of Object.entries(opts.providerEnv).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!MANAGED_PROFILE_ENV.has(name)) continue
    lines.push(envLine(name, value))
  }
  const kept = envLines(opts.previous ?? '').filter((line) => {
    if (line.startsWith(HEADER) || line === KEPT_HEADER) return false
    const name = ENV_NAME_RE.exec(line)?.[1]
    return name ? !MANAGED_PROFILE_ENV.has(name) : line.trim() !== ''
  })
  if (kept.length > 0) lines.push(KEPT_HEADER, ...kept)
  lines.push('')
  return lines.join('\n')
}

/** `terminal:` keys in a copied config that would override Clawboo's per-run
 *  folder (`cwd`) or move commands off this computer (`backend`). */
const PINNED_TERMINAL_KEYS = /^(\s+)(cwd|backend)(\s*:\s*)(.*)$/

/**
 * A profile's `config.yaml` with its `terminal:` block pinned: `cwd` set to the
 * placeholder `.` (so the per-run `TERMINAL_CWD` from `.env` applies; a concrete
 * `terminal.cwd` would win over it) and `backend` to `local` (commands run on
 * this computer, in the agent's folder, never in a container Hermes starts).
 * Line-level and pure, like the MCP block edit; other keys are left as written.
 */
export function pinTerminalBlock(body: string): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  let inTerminal = false
  let childIndent: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^[^\s#-]/.test(line)) {
      inTerminal = /^terminal\s*:\s*(#.*)?$/.test(line)
      childIndent = null
      continue
    }
    if (!inTerminal || line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (childIndent === null) childIndent = indent
    if (indent !== childIndent) continue
    const m = PINNED_TERMINAL_KEYS.exec(line)
    if (!m) continue
    const value = m[2] === 'cwd' ? '"."' : 'local'
    lines[i] = `${m[1]}${m[2]}${m[3]}${value}`
  }
  return lines.join(eol)
}

/** The approval modes Hermes reads from `approvals.mode`. */
export type HermesApprovalMode = 'manual' | 'smart' | 'off'

/**
 * The approval mode a profile runs with: the one the person's own
 * `~/.hermes/config.yaml` sets, read here by the server (never from the agent's
 * profile, which the agent can write), else `manual`. Hermes's own default is
 * `smart`, which first asks another model whether a flagged command is safe;
 * `manual` sends every flagged command to a Clawboo card, and costs nothing.
 */
export async function personsApprovalMode(): Promise<HermesApprovalMode> {
  try {
    if (!existsSync(userHermesConfigPath())) return 'manual'
    const read = readAsHermes(await readFile(userHermesConfigPath(), 'utf8'))
    return read === 'unreadable' ? 'manual' : (read.approvalMode ?? 'manual')
  } catch {
    return 'manual'
  }
}

/** The characters PyYAML's reader refuses. */
const PYYAML_NON_PRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[^\x09\x0A\x0D\x20-\x7E\x85\xA0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u

/** Text that is exactly UTF-8, or null (an invalid sequence, a stray byte). */
function strictUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The keys Clawboo pins in a profile, as Hermes would read them. */
interface PinnedAsRead {
  /** Null when the config sets none. */
  approvalMode: HermesApprovalMode | null
  backend: unknown
  cwd: unknown
}

/**
 * A `config.yaml` read the way Hermes reads it (PyYAML, YAML 1.1: the last of
 * duplicate keys wins, `<<` merges, a bare `off` is false). Anything a reader
 * could take two ways (a duplicate key, a tag, an error, more than one
 * document) is `unreadable`, so a check made here holds for Hermes too.
 */
export function readAsHermes(body: string): PinnedAsRead | 'unreadable' {
  // A character PyYAML refuses (its NON_PRINTABLE set), or a byte order mark:
  // Hermes would not read the file as this reads it.
  if (PYYAML_NON_PRINTABLE.test(body) || body.startsWith('\uFEFF')) return 'unreadable'
  try {
    const doc = parseDocument(body, { version: '1.1', uniqueKeys: true, merge: true })
    if (doc.errors.length > 0 || doc.warnings.length > 0) return 'unreadable'
    const js: unknown = doc.toJS({ maxAliasCount: 100 })
    if (js === null || js === undefined)
      return { approvalMode: null, backend: undefined, cwd: undefined }
    if (typeof js !== 'object' || Array.isArray(js)) return 'unreadable'
    const block = (key: string): Record<string, unknown> | null | 'bad' => {
      const v = (js as Record<string, unknown>)[key]
      if (v === undefined || v === null) return null
      return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : 'bad'
    }
    const approvals = block('approvals')
    const terminal = block('terminal')
    if (approvals === 'bad' || terminal === 'bad') return 'unreadable'
    // Hermes's own normalisation (approval_context._normalize_approval_mode).
    const raw = approvals?.['mode']
    const approvalMode: HermesApprovalMode | null =
      raw === undefined || raw === null
        ? null
        : typeof raw === 'boolean'
          ? raw
            ? 'manual'
            : 'off'
          : typeof raw === 'string' && ['manual', 'smart', 'off'].includes(raw.trim().toLowerCase())
            ? (raw.trim().toLowerCase() as HermesApprovalMode)
            : 'manual'
    return { approvalMode, backend: terminal?.['backend'], cwd: terminal?.['cwd'] }
  } catch {
    return 'unreadable'
  }
}

/** Whether a profile config reads, as Hermes reads it, with Clawboo's pins in
 *  force: the approval mode, and commands on this computer in the run's folder. */
export function holdsPins(body: string, mode: HermesApprovalMode): boolean {
  const read = readAsHermes(body)
  if (read === 'unreadable') return false
  return (
    read.approvalMode === mode &&
    (read.backend === undefined || read.backend === 'local') &&
    (read.cwd === undefined || read.cwd === '.')
  )
}

/**
 * A profile's `config.yaml` with `approvals.mode` set to `mode`, before every run
 * (line-level, like the terminal pin): an agent that edits its own profile to
 * turn its approvals off has it set back. Other `approvals:` keys (its timeout,
 * say) stay as written; a one-line `approvals:` value becomes a block.
 */
export function pinApprovalsMode(body: string, mode: HermesApprovalMode): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  // Quoted when it is `off`, which YAML 1.1 readers take for false.
  const value = mode === 'off' ? '"off"' : mode
  const lines = body.split(/\r?\n/)
  const at = lines.findIndex((l) => /^approvals\s*:/.test(l))
  if (at === -1) {
    const trimmed = body.replace(/\s+$/, '')
    return `${trimmed ? `${trimmed}${eol}` : ''}approvals:${eol}  mode: ${value}${eol}`
  }
  if (!/^approvals\s*:\s*(#.*)?$/.test(lines[at] ?? '')) {
    lines.splice(at, 1, 'approvals:', `  mode: ${value}`)
    return lines.join(eol)
  }
  let childIndent: number | null = null
  let pinned = false
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^[^\s#]/.test(line)) break
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (childIndent === null) childIndent = indent
    if (indent === childIndent && /^\s*mode\s*:/.test(line)) {
      lines[i] = `${' '.repeat(indent)}mode: ${value}`
      pinned = true
    }
  }
  if (!pinned) lines.splice(at + 1, 0, `${' '.repeat(childIndent ?? 2)}mode: ${value}`)
  return lines.join(eol)
}

/** Top-level `config.yaml` keys that hold a chat channel's identity or make a
 *  profile a multiplexer of its own (Hermes's own profile cloning drops the
 *  same, `profile_channels.py`): not carried into a Clawboo profile, or the
 *  person's own bot would be answered by a Clawboo agent too. */
const CHANNEL_CONFIG_KEYS = new Set([
  'platforms',
  'gateway',
  'multiplex_profiles',
  'profile_routes',
  'telegram',
  'discord',
  'whatsapp',
  'whatsapp_cloud',
  'slack',
  'signal',
  'mattermost',
  'matrix',
  'email',
  'sms',
  'dingtalk',
  'api_server',
  'webhook',
  'msgraph_webhook',
  'feishu',
  'wecom',
  'wecom_callback',
  'weixin',
  'bluebubbles',
  'qqbot',
  'relay',
  'google_chat',
  'homeassistant',
  'irc',
  'line',
])

/** A copied `config.yaml` without its channel blocks (line-level: each listed
 *  top-level key and everything indented under it). */
export function withoutChannelBlocks(body: string): string {
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  let skipping = false
  for (const line of body.split(/\r?\n/)) {
    if (/^[^\s#]/.test(line)) {
      const key = /^["']?([A-Za-z0-9_-]+)["']?\s*:/.exec(line)?.[1]
      skipping = key !== undefined && CHANNEL_CONFIG_KEYS.has(key)
    }
    if (!skipping) out.push(line)
  }
  return out.join(eol)
}

/** Writes of one profile's `.env` go one at a time, each reading the file it
 *  rewrites under the same turn, so a key refresh never undoes a run's folder. */
const envWrites = new Map<string, Promise<unknown>>()

function serializedEnvWrite<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = envWrites.get(dir) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  const settled = next.catch(() => undefined)
  envWrites.set(dir, settled)
  void settled.then(() => {
    if (envWrites.get(dir) === settled) envWrites.delete(dir)
  })
  return next
}

/** A profile path Clawboo writes in must be a real folder, never a link: a link
 *  there could aim the writes anywhere, the person's own `~/.hermes` included. */
async function assertNotLink(p: string): Promise<void> {
  if ((await agentStat(p))?.type === 'link') {
    throw new Error(`refusing to use a Hermes profile path that is a link: ${p}`)
  }
}

/** Where the profiles of agents Clawboo no longer has are set aside: out of
 *  the gateway's sight (their jobs stop), kept in case the agent comes back. */
export function setAsideProfilesDir(gatewayHome: string): string {
  return path.join(gatewayHome, 'profiles-set-aside')
}

export interface ProvisionedProfile {
  profile: string
  dir: string
  /** The profile folder did not exist before this provision. */
  created: boolean
  /** The agent's old Hermes home was moved into it. */
  migrated: boolean
  /** Clawboo's MCP servers are in its config.yaml. */
  mcpAttached: boolean
}

/** Whether a folder holds anything. */
async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/**
 * Make (or refresh) a profile for one run: move the agent's old home in if this
 * is its first time, write its `.env`, keep the MCP block of its `config.yaml`
 * current, and seed its ChatGPT sign-in. A profile folder is created by renaming
 * a finished staging folder into place, so the gateway's rescan never serves one
 * half written.
 */
export async function provisionProfile(opts: {
  gatewayHome: string
  profile: string
  /** The agent's old Hermes home, to move in once. Null for a throwaway run. */
  legacyHome: string | null
  key: string
  cwd: string | null
  providerEnv: Record<string, string>
  mcpServers: HermesMcpServers | null
}): Promise<ProvisionedProfile> {
  const profilesDir = path.join(opts.gatewayHome, 'profiles')
  const dir = hermesProfileDir(opts.gatewayHome, opts.profile)
  await assertNotLink(opts.gatewayHome)
  await agentMkdir(profilesDir)
  await assertNotLink(profilesDir)
  await assertNotLink(dir)
  let created = false
  let migrated = false
  const setAside = path.join(setAsideProfilesDir(opts.gatewayHome), opts.profile)
  if (!(await agentStat(dir)) && (await agentStat(setAside))?.type === 'dir') {
    // An agent set aside earlier is back: its profile returns as it was.
    await agentRename(setAside, dir)
  }
  if (!(await agentStat(dir))) {
    created = true
    const legacy = opts.legacyHome
    if (legacy && (await agentStat(legacy))?.type === 'dir' && (await hasEntries(legacy))) {
      // Same file system (both are under the runtimes homes), so a rename moves
      // memory, skills and sessions in one step.
      await agentRename(legacy, dir)
      migrated = true
    } else {
      const staging = path.join(
        profilesDir,
        `.staging-${opts.profile}-${randomBytes(4).toString('hex')}`,
      )
      await agentMkdir(staging)
      try {
        await agentWriteFile(path.join(staging, '.env'), renderProfileEnv(opts))
        await agentRename(staging, dir)
      } catch (err) {
        await agentRemove(staging).catch(() => undefined)
        throw err
      }
    }
  }

  const envPath = path.join(dir, '.env')
  await serializedEnvWrite(dir, async () => {
    const previousEnv = (await agentReadFile(envPath))?.toString('utf8') ?? null
    await agentWriteFile(envPath, renderProfileEnv({ ...opts, previous: previousEnv }))
  })

  // config.yaml: seeded once from the person's own Hermes config while it holds
  // nothing of its own, then only the marked MCP block and the pinned terminal
  // keys change.
  const configPath = path.join(dir, 'config.yaml')
  const onDiskBytes = await agentReadFile(configPath)
  // Decoded strictly: a file that is not exactly UTF-8 is not kept (Hermes would
  // read other text than the check below reads), and is rebuilt.
  const onDisk = onDiskBytes ? strictUtf8(onDiskBytes) : null
  let base = onDisk ?? ''
  // With agents on their own OS user the person's own config is never copied
  // into agent space: it can hold a provider's `api_key`, which any agent could
  // read there. (Its approval mode is still read by the server, below.)
  const agentMode = isAgentUserMode()
  if (
    !agentMode &&
    mergeClawbooMcpServers(base, null).body === '' &&
    existsSync(userHermesConfigPath())
  ) {
    try {
      // The person's own file, read as the server (never through agent space),
      // without the chat channels it runs.
      base = withoutChannelBlocks(await readFile(userHermesConfigPath(), 'utf8'))
    } catch {
      // Seeding is best effort; Hermes falls back to its defaults.
    }
  }
  const mode = await personsApprovalMode()
  const build = (from: string) =>
    mergeClawbooMcpServers(pinApprovalsMode(pinTerminalBlock(from), mode), opts.mcpServers)
  let merged = build(base)
  // The pins are line edits; what counts is what Hermes reads. A config that
  // does not read back with them in force (a second `approvals:` key, a quoted
  // or merged one, anything ambiguous) is not kept: the profile gets the
  // person's own config again, or none.
  if (!holdsPins(merged.body, mode)) {
    let fresh = ''
    try {
      if (!agentMode && existsSync(userHermesConfigPath()))
        fresh = withoutChannelBlocks(await readFile(userHermesConfigPath(), 'utf8'))
    } catch {
      fresh = ''
    }
    merged = build(fresh)
    if (!holdsPins(merged.body, mode)) merged = build('')
    log.warn(
      { profile: opts.profile },
      "the agent's Hermes config.yaml did not keep Clawboo's settings; it was rebuilt",
    )
  }
  // Compared as bytes: Hermes only ever reads bytes Clawboo wrote from the text
  // it checked.
  const want = Buffer.from(merged.body, 'utf8')
  if (merged.body === '') {
    if (onDiskBytes) await agentRemove(configPath)
  } else if (!onDiskBytes || !onDiskBytes.equals(want)) {
    await agentWriteFile(configPath, want)
  }
  // The ChatGPT sign-in (seedHermesAuth copies only the agent user's own with
  // agents on their own OS user, never the person's). A run with a provider key
  // gets none copied in then.
  const hasApiKey = Object.values(opts.providerEnv).some(Boolean)
  if (!(agentMode && hasApiKey)) await seedHermesAuth(dir)
  return { profile: opts.profile, dir, created, migrated, mcpAttached: merged.attached }
}

/** The provider keys Clawboo writes into a profile's `.env`. */
const PROVIDER_KEYS = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

/** A profile `.env` with its provider keys replaced by `providerEnv`'s (none
 *  when it has none), every other line kept. Pure. */
export function withProviderKeys(body: string, providerEnv: Record<string, string>): string {
  const lines = envLines(body).filter((line) => {
    const name = ENV_NAME_RE.exec(line)?.[1]
    return !name || !(PROVIDER_KEYS as readonly string[]).includes(name)
  })
  const keys = PROVIDER_KEYS.filter((k) => providerEnv[k]).map((k) => envLine(k, providerEnv[k]!))
  const at = lines.indexOf(KEPT_HEADER)
  const insertAt = at === -1 ? lines.length - (lines.at(-1) === '' ? 1 : 0) : at
  lines.splice(insertAt, 0, ...keys)
  return lines.join('\n')
}

/**
 * Bring every Clawboo profile's provider keys in line with the vault. A profile
 * keeps its keys between runs, for the jobs Hermes runs on its own, so a key
 * disconnected in Clawboo must leave the profiles too, and the gateway starts
 * with the keys Clawboo holds now.
 */
export async function refreshProfileProviderKeys(
  gatewayHome: string,
  providerEnv: Record<string, string>,
): Promise<void> {
  for (const profile of await listClawbooProfiles(gatewayHome)) {
    // A throwaway profile gets its keys for its one run, and is gone after it.
    if (profile.startsWith('cbtmp-')) continue
    const dir = hermesProfileDir(gatewayHome, profile)
    if ((await agentStat(dir))?.type !== 'dir') continue
    const envPath = path.join(dir, '.env')
    await serializedEnvWrite(dir, async () => {
      const body = (await agentReadFile(envPath))?.toString('utf8')
      if (body === undefined) return
      const next = withProviderKeys(body, providerEnv)
      if (next !== body) await agentWriteFile(envPath, next)
    })
  }
}

/**
 * Tidy the profiles at a gateway start: remove throwaway profiles a run left
 * (only when no run can be using one: at server start), and set aside the
 * profile of every agent Clawboo no longer has, so its jobs stop firing on the
 * keys Clawboo gives Hermes. `keep` is every current agent's profile; when it
 * cannot be read, nothing is set aside.
 */
export async function tidyProfiles(
  gatewayHome: string,
  opts: { keep: ReadonlySet<string> | null; removeThrowaways: boolean },
): Promise<{ removed: string[]; setAside: string[] }> {
  const removed: string[] = []
  const setAside: string[] = []
  for (const profile of await listClawbooProfiles(gatewayHome)) {
    const dir = hermesProfileDir(gatewayHome, profile)
    if (profile.startsWith('cbtmp-')) {
      if (!opts.removeThrowaways) continue
      await agentRemove(dir)
      removed.push(profile)
      continue
    }
    if (!opts.keep || opts.keep.has(profile)) continue
    const asideDir = setAsideProfilesDir(gatewayHome)
    await agentMkdir(asideDir)
    const target = path.join(asideDir, profile)
    if (await agentStat(target)) await agentRemove(target)
    await agentRename(dir, target)
    setAside.push(profile)
  }
  return { removed, setAside }
}

/** Write the gateway home's own files. */
export async function provisionGatewayHome(opts: {
  home: string
  port: number
  key: string
  maxConcurrentRuns?: number
}): Promise<void> {
  await agentMkdir(opts.home)
  await agentMkdir(path.join(opts.home, 'profiles'))
  await agentMkdir(path.join(opts.home, '.clawboo-locks'))
  await agentWriteFile(path.join(opts.home, 'config.yaml'), renderGatewayConfig(opts))
  await agentWriteFile(path.join(opts.home, '.env'), renderGatewayEnv(opts))
}

/** The Clawboo profiles in the gateway home, by name. */
export async function listClawbooProfiles(gatewayHome: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(gatewayHome, 'profiles'), { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && isClawbooProfile(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
