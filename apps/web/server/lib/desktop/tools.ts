// The programs that give agents a screen of their own on Linux, installed into
// Clawboo's runtimes folder: TigerVNC's Xvnc (the display) and Cua Driver (the
// desktop driver). Pinned releases, each checked against a SHA-256 before it
// is unpacked, installed beside the current install and switched to only when
// everything worked (`commitRuntimeInstall`), like the agent runtimes.
//
// TigerVNC is GPL-2.0 and runs as a program of its own; Clawboo never links it.
// Cua Driver is MIT. Neither is installed unless a person asks.
//
// Xvnc from TigerVNC's own Linux build still loads a few system libraries
// (libxcvt, libxshmfence, libgbm, libX11, libpam, libsystemd) and runs the
// system's `xkbcomp` with its keyboard data; Clawboo installs none of them. On
// Debian and Ubuntu: libxcvt0, libxshmfence1, libgbm1, x11-xkb-utils, xkb-data
// (or tigervnc-standalone-server, whose own Xvnc is then used). A display
// that cannot start says which one is missing (see displays.ts
// `displayProblem`).

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { findExecutable } from '../platform'
import {
  commitRuntimeInstall,
  discardInstallFolder,
  markInstallInUse,
  newInstallFolder,
  ownedRuntimeLaunch,
  withInstallUmask,
} from '../runtimeFolder'

/** The runtimes-folder id the desktop tools install under. */
export const DESKTOP_TOOLS_ID = 'desktop'

/** The launcher names: lower case, as the runtimes folder requires. */
export const XVNC_LAUNCHER = 'xvnc'
export const CUA_DRIVER_LAUNCHER = 'cua-driver'

export interface PinnedArtifact {
  url: string
  sha256: string
  /** The largest the download may be, a little over its real size. */
  maxBytes: number
  /** The folder inside the archive that is the install (stripped), if any. */
  stripPrefix?: string
}

type Arch = 'x64' | 'arm64'

export const TIGERVNC_VERSION = '1.16.2'
export const CUA_DRIVER_VERSION = '0.38.0'

/** TigerVNC publishes its own Linux build for x86_64 only. */
const TIGERVNC: Partial<Record<Arch, PinnedArtifact>> = {
  x64: {
    url: `https://downloads.sourceforge.net/project/tigervnc/stable/${TIGERVNC_VERSION}/tigervnc-${TIGERVNC_VERSION}.x86_64.tar.gz`,
    sha256: '5b70c84baefc09a030cfc78315c34ccb55b2a0dde4092b7da67a1962c5f0dea6',
    maxBytes: 20 * 1024 * 1024,
    stripPrefix: `tigervnc-${TIGERVNC_VERSION}.x86_64`,
  },
}

/** Cua Driver's release archives; the hashes are its own SHA256SUMS. */
const CUA_DRIVER: Partial<Record<Arch, PinnedArtifact>> = {
  x64: {
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    sha256: '31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd',
    maxBytes: 48 * 1024 * 1024,
  },
  arm64: {
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64-binary.tar.gz`,
    sha256: '80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d',
    maxBytes: 48 * 1024 * 1024,
  },
}

/** How long a download may go without a byte before it is given up. */
const DOWNLOAD_STALL_MS = 60_000

export class DesktopToolsError extends Error {
  constructor(
    message: string,
    readonly code:
      'UNSUPPORTED' | 'DOWNLOAD_FAILED' | 'CHECKSUM' | 'UNPACK_FAILED' | 'INSTALL_FAILED',
  ) {
    super(message)
    this.name = 'DesktopToolsError'
  }
}

/** What would be installed here: either may be null on this machine. */
export function desktopToolsPlan(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { tigervnc: PinnedArtifact | null; cuaDriver: PinnedArtifact | null } {
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) {
    return { tigervnc: null, cuaDriver: null }
  }
  return { tigervnc: TIGERVNC[arch] ?? null, cuaDriver: CUA_DRIVER[arch] ?? null }
}

/** Whether each Xvnc found so far is TigerVNC's, by path. */
const tigerVncByPath = new Map<string, boolean>()

/** Whether `file` is TigerVNC's Xvnc: `-version` prints "Xvnc TigerVNC <version>" and exits. */
function isTigerVnc(file: string): boolean {
  const known = tigerVncByPath.get(file)
  if (known !== undefined) return known
  const r = spawnSync(file, ['-version'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C' },
  })
  const yes = /\bXvnc TigerVNC\b/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  tigerVncByPath.set(file, yes)
  return yes
}

/**
 * The system's own TigerVNC Xvnc, or null. Debian and Ubuntu install it as
 * `Xtigervnc`; Fedora, Arch and openSUSE as `Xvnc`. An `Xvnc` can also be
 * TightVNC's, KasmVNC's or TurboVNC's, which do not take the options a display
 * is started with (or open listeners of their own), so only one whose version
 * says TigerVNC counts, and Clawboo's own copy can then be installed and used.
 */
export function systemXvnc(
  find: (name: string) => string | null = findExecutable,
  isTiger: (file: string) => boolean = isTigerVnc,
): string | null {
  for (const name of ['Xtigervnc', 'Xvnc']) {
    const file = find(name)
    if (file && isTiger(file)) return file
  }
  return null
}

/** Clawboo's own Xvnc, or null when it is not installed (or not safe to run). */
export function ownedXvnc(): string | null {
  return ownedRuntimeLaunch(XVNC_LAUNCHER)?.command ?? null
}

/** Clawboo's own Cua Driver, or null when it is not installed. */
export function ownedCuaDriver(): string | null {
  return ownedRuntimeLaunch(CUA_DRIVER_LAUNCHER)?.command ?? null
}

/**
 * Keep the install a started tool runs from for as long as it runs. A later
 * install prunes every folder but the current and previous ones, and Cua
 * Driver starts copies of its own binary. `command` is what was spawned (the
 * launcher or the program); anything not from the desktop tools is ignored.
 */
export function markDesktopToolsInUse(command: string, pid: number | null | undefined): void {
  if (typeof pid !== 'number') return
  const ours = [XVNC_LAUNCHER, CUA_DRIVER_LAUNCHER].some((name) => {
    const launch = ownedRuntimeLaunch(name)
    return launch !== null && (command === launch.launcher || command === launch.command)
  })
  if (ours) markInstallInUse(DESKTOP_TOOLS_ID, pid)
}

/** A download running in another program (curl), streaming to its stdout. */
export interface DownloadProcess {
  stdout: Readable
  /** Resolves with the exit code once the program has ended. */
  exited: Promise<number>
  kill(): void
}

/** A response being read: its status and its body as it arrives. */
export interface DownloadResponse {
  status: number
  body: Readable
}

export interface DesktopToolsDeps {
  /** GET a URL, following redirects (to https only). */
  download?: (url: string, signal: AbortSignal) => Promise<DownloadResponse>
  /** Run a command; resolves with its exit code. */
  run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>
  /** Start curl with these arguments (a download behind a proxy). */
  curl?: (args: string[], env: NodeJS.ProcessEnv) => DownloadProcess
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  stallMs?: number
  /** The longest one download may take in all, however steadily it moves. */
  deadlineMs?: number
  /** Tests only: what to install instead of the pinned releases. */
  plan?: { tigervnc: PinnedArtifact | null; cuaDriver: PinnedArtifact | null }
  /** The system's own Xvnc, when it has one (then TigerVNC is not downloaded). */
  systemXvnc?: () => string | null
}

/** How long one download may take in all. */
const DOWNLOAD_DEADLINE_MS = 15 * 60_000

/** Release hosts redirect to their file stores (GitHub's, SourceForge's mirrors). */
const MAX_REDIRECTS = 5

/**
 * GET `url` with node:https, following redirects to https addresses only.
 *
 * Not Node's own fetch: under backpressure, a response whose TLS connection
 * ends while its reader is paused trips an internal assertion in the fetch
 * implementation Node ships (undici's `assert(!this.paused)`), thrown where no
 * caller can catch it, which takes the whole server down. Seen on a 37 MB
 * release download.
 */
export function httpsDownload(
  url: string,
  signal: AbortSignal,
  redirects = MAX_REDIRECTS,
): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      reject(new Error('not a URL'))
      return
    }
    if (target.protocol !== 'https:') {
      reject(new Error(`a redirect to ${target.protocol} was refused`))
      return
    }
    const req = https.get(target, { signal, headers: { 'user-agent': 'clawboo' } }, (res) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        res.resume()
        if (redirects <= 0) {
          reject(new Error('too many redirects'))
          return
        }
        let next: string
        try {
          next = new URL(location, target).toString()
        } catch {
          reject(new Error('a redirect to no URL'))
          return
        }
        httpsDownload(next, signal, redirects - 1).then(resolve, reject)
        return
      }
      resolve({ status, body: res })
    })
    req.on('error', reject)
  })
}

function defaultRun(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    // Server side, as the server's own user: an install, not agent work.
    const child = spawn(command, args, { env, stdio: 'ignore', shell: false })
    child.once('error', () => resolve(127))
    child.once('close', (code) => resolve(code ?? 1))
  })
}

function defaultCurl(args: string[], env: NodeJS.ProcessEnv): DownloadProcess {
  const child = spawn('curl', args, { env, stdio: ['ignore', 'pipe', 'ignore'], shell: false })
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => resolve(127))
    child.once('close', (code) => resolve(code ?? 1))
  })
  return { stdout: child.stdout, exited, kill: () => child.kill('SIGKILL') }
}

function httpsProxyOf(env: NodeJS.ProcessEnv): string | null {
  const p = env['HTTPS_PROXY'] ?? env['https_proxy'] ?? ''
  return p.trim() || null
}

/**
 * Only the variables `names` lists, from `env`. curl and tar both take options
 * from their environment (`TAR_OPTIONS`, a proxy for another scheme, a CA
 * bundle swap), and an install must not run with whatever the server inherited.
 */
function onlyEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { LC_ALL: 'C' }
  for (const name of names) {
    const v = env[name]
    if (typeof v === 'string') out[name] = v
  }
  return out
}

const CURL_ENV = [
  'PATH',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
] as const
const TAR_ENV = ['PATH'] as const

/**
 * Download `art` to `file`, refusing anything over its size or with another
 * hash. The bytes are counted, hashed and written as they arrive, through
 * node:https or, behind a proxy, curl's standard output: either way nothing
 * past `maxBytes` reaches the disk (curl's own `--max-filesize` does not hold
 * a response of unknown length before 8.4), and the download has a total
 * deadline as well as a stall timeout.
 */
async function downloadVerified(
  art: PinnedArtifact,
  file: string,
  deps: Required<Pick<DesktopToolsDeps, 'download' | 'curl'>> & {
    env: NodeJS.ProcessEnv
    stallMs: number
    deadlineMs: number
  },
): Promise<void> {
  const host = new URL(art.url).host
  const unreachable = (detail: string) =>
    new DesktopToolsError(
      `Could not download from ${host} (${detail}). Check that this computer is online; behind a proxy, start Clawboo with HTTPS_PROXY set to it.`,
      'DOWNLOAD_FAILED',
    )
  const stop = new AbortController()
  let why: 'stall' | 'deadline' | null = null
  const giveUp = (reason: 'stall' | 'deadline') => {
    why ??= reason
    stop.abort()
  }
  let stall: ReturnType<typeof setTimeout> | null = null
  const moved = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => giveUp('stall'), deps.stallMs)
    stall.unref?.()
  }
  const deadline = setTimeout(() => giveUp('deadline'), deps.deadlineMs)
  deadline.unref?.()
  const late = () =>
    why === 'deadline' ? 'it took too long' : why === 'stall' ? 'no data in time' : null

  let curl: DownloadProcess | null = null
  try {
    moved()
    let body: Readable
    if (httpsProxyOf(deps.env)) {
      // node:https does not use a proxy from the environment; curl does.
      // `-q` first, so no ~/.curlrc adds options of its own.
      const seconds = String(Math.max(1, Math.round(deps.stallMs / 1000)))
      curl = deps.curl(
        [
          '-q',
          '-fsSL',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--connect-timeout',
          '30',
          '--speed-time',
          seconds,
          '--speed-limit',
          '1',
          '--max-filesize',
          String(art.maxBytes),
          art.url,
        ],
        onlyEnv(deps.env, CURL_ENV),
      )
      const proc = curl
      stop.signal.addEventListener('abort', () => proc.kill(), { once: true })
      body = proc.stdout
    } else {
      let res: DownloadResponse
      try {
        res = await deps.download(art.url, stop.signal)
      } catch (err) {
        throw unreachable(late() ?? String((err as Error).message))
      }
      if (res.status !== 200) {
        res.body.destroy()
        throw unreachable(`HTTP ${res.status}`)
      }
      body = res.body
    }

    const hash = createHash('sha256')
    let seen = 0
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        moved()
        seen += chunk.length
        if (seen > art.maxBytes) {
          cb(new DesktopToolsError(`${host} sent more than expected`, 'DOWNLOAD_FAILED'))
          return
        }
        hash.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(body, guard, createWriteStream(file, { mode: 0o600 }), {
        signal: stop.signal,
      })
    } catch (err) {
      if (err instanceof DesktopToolsError) throw err
      throw unreachable(late() ?? String((err as Error).message))
    }
    if (curl) {
      const code = await curl.exited
      if (code !== 0) throw unreachable(`curl through the proxy exited with code ${code}`)
    }
    const actual = hash.digest('hex')
    if (actual !== art.sha256) {
      throw new DesktopToolsError(
        `The download from ${host} is not the release Clawboo pins (SHA-256 ${actual}, expected ${art.sha256}). Nothing was installed.`,
        'CHECKSUM',
      )
    }
  } finally {
    if (stall) clearTimeout(stall)
    clearTimeout(deadline)
    curl?.kill()
  }
}

async function unpack(
  archive: string,
  dest: string,
  art: PinnedArtifact,
  deps: { run: NonNullable<DesktopToolsDeps['run']>; env: NodeJS.ProcessEnv },
): Promise<void> {
  const args = [
    '-xzf',
    archive,
    '-C',
    dest,
    // The archives are owned by root; files keep this user, or the runtimes
    // folder's seal refuses them.
    '--no-same-owner',
    '--no-same-permissions',
    ...(art.stripPrefix ? ['--strip-components=1', art.stripPrefix] : []),
  ]
  // Only PATH: tar reads TAR_OPTIONS (and more) from its environment.
  const code = await withInstallUmask(() => deps.run('tar', args, onlyEnv(deps.env, TAR_ENV)))
  if (code !== 0)
    throw new DesktopToolsError(
      `Could not unpack ${path.basename(archive)} (tar exited with ${code}).`,
      'UNPACK_FAILED',
    )
}

export interface DesktopToolsInstall {
  tigervnc: string | null
  cuaDriver: string | null
  folder: string
}

/** The install running now, which a second request joins rather than racing:
 *  committing one prunes the other's unfinished folder. */
let installing: Promise<DesktopToolsInstall> | null = null

/**
 * Install the pinned desktop tools that exist for this machine into the
 * runtimes folder, and make them current. Linux only. Returns what was
 * installed; throws `DesktopToolsError` with a sentence a person can act on.
 */
export function installDesktopTools(deps: DesktopToolsDeps = {}): Promise<DesktopToolsInstall> {
  installing ??= runInstall(deps).finally(() => {
    installing = null
  })
  return installing
}

async function runInstall(deps: DesktopToolsDeps): Promise<DesktopToolsInstall> {
  const env = deps.env ?? process.env
  const pinned = deps.plan ?? desktopToolsPlan(deps.platform, deps.arch)
  // An Xvnc from the system's own package is used first (its package brings the
  // libraries it loads), so a second one is not downloaded beside it.
  const hasSystemXvnc = (deps.systemXvnc ?? (() => systemXvnc()))() !== null
  const plan = { ...pinned, tigervnc: hasSystemXvnc ? null : pinned.tigervnc }
  if (!pinned.tigervnc && !pinned.cuaDriver) {
    throw new DesktopToolsError(
      'A screen of its own for each agent needs Linux on x86_64 or arm64.',
      'UNSUPPORTED',
    )
  }
  if (!plan.tigervnc && !plan.cuaDriver) {
    throw new DesktopToolsError(
      "Nothing to install: this system's own Xvnc is used.",
      'UNSUPPORTED',
    )
  }
  const ctx = {
    download: deps.download ?? httpsDownload,
    run: deps.run ?? defaultRun,
    curl: deps.curl ?? defaultCurl,
    env,
    stallMs: deps.stallMs ?? DOWNLOAD_STALL_MS,
    deadlineMs: deps.deadlineMs ?? DOWNLOAD_DEADLINE_MS,
  }
  const folder = newInstallFolder(DESKTOP_TOOLS_ID, undefined, env)
  try {
    const launchers: Record<string, { command: string; args: string[] }> = {}
    if (plan.tigervnc) {
      const dir = path.join(folder, 'tigervnc')
      await mkdir(dir, { mode: 0o755 })
      const archive = path.join(folder, 'tigervnc.tar.gz')
      await downloadVerified(plan.tigervnc, archive, ctx)
      await unpack(archive, dir, plan.tigervnc, ctx)
      await rm(archive, { force: true })
      launchers[XVNC_LAUNCHER] = { command: path.join(dir, 'usr', 'bin', 'Xvnc'), args: [] }
    }
    if (plan.cuaDriver) {
      const dir = path.join(folder, 'cua-driver')
      await mkdir(dir, { mode: 0o755 })
      const archive = path.join(folder, 'cua-driver.tar.gz')
      await downloadVerified(plan.cuaDriver, archive, ctx)
      await unpack(archive, dir, plan.cuaDriver, ctx)
      await rm(archive, { force: true })
      launchers[CUA_DRIVER_LAUNCHER] = { command: path.join(dir, 'cua-driver'), args: [] }
    }
    for (const launch of Object.values(launchers)) {
      const st = await stat(launch.command).catch(() => null)
      if (!st?.isFile()) {
        throw new DesktopToolsError(
          `The release did not hold ${path.basename(launch.command)} where expected.`,
          'UNPACK_FAILED',
        )
      }
    }
    const versions = [
      plan.tigervnc ? `tigervnc ${TIGERVNC_VERSION}` : null,
      plan.cuaDriver ? `cua-driver ${CUA_DRIVER_VERSION}` : null,
    ].filter(Boolean)
    commitRuntimeInstall(
      DESKTOP_TOOLS_ID,
      {
        folder,
        version: versions.join(', '),
        source: [plan.tigervnc?.url, plan.cuaDriver?.url].filter(Boolean).join(' '),
        launchers,
      },
      env,
    )
    return {
      tigervnc: launchers[XVNC_LAUNCHER]?.command ?? null,
      cuaDriver: launchers[CUA_DRIVER_LAUNCHER]?.command ?? null,
      folder,
    }
  } catch (err) {
    await discardInstallFolder(folder)
    if (err instanceof DesktopToolsError) throw err
    throw new DesktopToolsError(
      `Could not install the desktop tools: ${(err as Error).message}`,
      'INSTALL_FAILED',
    )
  }
}
