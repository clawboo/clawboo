// Install the pinned Hermes release into Clawboo's runtimes folder.
//
//   <runtimes>/hermes/<tag>/
//     src/          the release's source tree, from the tag tarball (sha256-checked);
//                   Hermes runs from its own tree, it refuses to be packaged
//     toolchain/uv/ the uv build the release pins in pm/lock.json (sha256-checked)
//     toolchain/python/
//                   the CPython build it pins (python-build-standalone, sha256-checked);
//                   v0.23.1 runs only on Python 3.14, so no system Python is used
//     venv/         an editable `uv sync --frozen` from the release's own uv.lock,
//                   so every dependency is the version and hash Hermes locked
//
// Then `src/install-stamp.json` (how a tree with no git history reports its
// version), a check that `hermes --version` names the release, and the switch:
// the runtimes folder's pointer names this install and `bin/hermes` runs it. An
// update installs beside the current one and switches only when it worked. On
// any failure the half-made folder is removed and the current install stays.
//
// Nothing is piped into a shell: every download is checked against a pinned
// hash before it is unpacked, and every command runs with argument lists.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  commitRuntimeInstall,
  discardInstallFolder,
  newInstallFolder,
  ownedRuntimeLaunch,
  readRuntimeInstall,
  withInstallUmask,
} from '../../runtimeFolder'
import { HERMES_RELEASE, pinnedToolchain, pmPlatformKey, type PinnedArtifact } from './release'

/** How long a download may go without a byte before it is given up. */
const DOWNLOAD_STALL_MS = 60_000

export type HermesInstallEvent =
  { type: 'progress'; step: string; message: string } | { type: 'output'; line: string }

export class HermesInstallError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'HermesInstallError'
  }
}

export interface HermesInstallDeps {
  fetch?: typeof fetch
  /** Run a command; resolves with its exit code. Output lines go to `onLine`. */
  run?: (
    command: string,
    args: string[],
    opts: {
      cwd?: string
      env?: Record<string, string>
      onLine: (line: string) => void
      signal?: AbortSignal
    },
  ) => Promise<number>
  platform?: NodeJS.Platform
  arch?: string
  musl?: boolean
  env?: NodeJS.ProcessEnv
  /** Tests only: how long a download may go without a byte. */
  downloadStallMs?: number
}

/** Whether this Linux uses musl (Alpine): glibc reports its version, musl does not. */
export function isMuslLinux(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
    return !report?.header?.glibcVersionRuntime
  } catch {
    return false
  }
}

function runCommand(
  command: string,
  args: string[],
  opts: {
    cwd?: string
    env?: Record<string, string>
    onLine: (line: string) => void
    signal?: AbortSignal
  },
): Promise<number> {
  return new Promise((resolve, reject) => {
    // Under the install umask, so nothing it writes is writable by others.
    const child = withInstallUmask(() =>
      spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? (process.env as Record<string, string>),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    )
    const lines = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) opts.onLine(line)
    }
    child.stdout?.on('data', lines)
    child.stderr?.on('data', lines)
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** Download `url` to `file`, checking its sha256 as it streams. */
/** The proxy the environment names for https, if any. */
export function httpsProxyOf(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[name]?.trim()
    if (v) return v
  }
  return null
}

/** The sha256 of a file on disk. */
async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Download `url` to `file` and check its sha256 before anything reads it. Node's
 * own fetch does not go through an https proxy, so with one set in the
 * environment the download is curl's (which reads it); uv, which installs the
 * dependencies, reads it too.
 */
async function download(
  ctx: {
    fetch: typeof fetch
    run: NonNullable<HermesInstallDeps['run']>
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    stallMs?: number
  },
  url: string,
  sha256: string,
  file: string,
): Promise<void> {
  const host = new URL(url).host
  const stallMs = ctx.stallMs ?? DOWNLOAD_STALL_MS
  const stallSeconds = Math.max(1, Math.round(stallMs / 1000))
  const unreachable = (detail: string): HermesInstallError =>
    new HermesInstallError(
      `Could not download from ${host} (${detail}). Check that this computer is online; behind a proxy, start Clawboo with HTTPS_PROXY set to it.`,
      'DOWNLOAD_FAILED',
    )
  if (httpsProxyOf(ctx.env)) {
    const code = await ctx
      .run(
        'curl',
        [
          '-fsSL',
          '--proto',
          '=https',
          '--connect-timeout',
          '30',
          // Give up on a download that stops moving.
          '--speed-time',
          String(stallSeconds),
          '--speed-limit',
          '1',
          '-o',
          file,
          url,
        ],
        {
          env: ctx.env as Record<string, string>,
          onLine: () => undefined,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      )
      .catch(() => 127)
    if (code !== 0) throw unreachable(`curl through the proxy exited with code ${code}`)
  } else {
    // A download that stops moving for `stallMs` is given up, so a
    // stalled network never holds the install open.
    const stall = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const moved = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => stall.abort(), stallMs)
      timer.unref?.()
    }
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, stall.signal]) : stall.signal
    const failure = (err: unknown): HermesInstallError => {
      if (stall.signal.aborted) return unreachable(`no data for ${stallSeconds}s`)
      const cause = (err as { cause?: { code?: string; message?: string } }).cause
      return unreachable(
        cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err)),
      )
    }
    try {
      moved()
      let res: Response
      try {
        res = await ctx.fetch(url, { redirect: 'follow', signal })
      } catch (err) {
        throw failure(err)
      }
      if (!res.ok || !res.body) throw unreachable(`it answered ${res.status}`)
      const watch = new Transform({
        transform(chunk, _enc, done) {
          moved()
          done(null, chunk)
        },
      })
      try {
        await pipeline(
          Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
          watch,
          createWriteStream(file, { mode: 0o644 }),
          { signal },
        )
      } catch (err) {
        throw failure(err)
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const got = await fileSha256(file)
  if (got !== sha256) {
    await rm(file, { force: true })
    throw new HermesInstallError(
      `The download from ${url} does not match its pinned hash (expected ${sha256}, got ${got}). Nothing was installed.`,
      'DIGEST_MISMATCH',
    )
  }
}

/** Where an unpacked tool's executable is: at the top of its folder, or in the
 *  one folder its archive put there. */
async function locateTool(dir: string, exe: string): Promise<string> {
  const top = path.join(dir, exe)
  if (await stat(top).catch(() => null)) return top
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const inner = path.join(dir, entry.name, exe)
    if (entry.isDirectory() && (await stat(inner).catch(() => null))) return inner
  }
  throw new HermesInstallError(`The unpacked download has no ${exe}.`, 'STEP_FAILED')
}

/** The managed Python inside an install. */
export function hermesPythonPath(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? path.join(folder, 'toolchain', 'python', 'python.exe')
    : path.join(folder, 'toolchain', 'python', 'bin', 'python3')
}

/** The `hermes` command inside an install's venv. */
export function hermesVenvCommand(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? path.join(folder, 'venv', 'Scripts', 'hermes.exe')
    : path.join(folder, 'venv', 'bin', 'hermes')
}

/** The `hermes` Clawboo installed and runs, or null when there is none (or the
 *  runtimes folder no longer passes its safety checks). The gateway starts this
 *  executable itself, not the `bin/` launcher, so no shell sits in between. */
export function managedHermesCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  return ownedRuntimeLaunch('hermes', env)?.command ?? null
}

/** The version of the install Clawboo runs, or null. */
export function managedHermesVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  return readRuntimeInstall('hermes', env)?.version ?? null
}

/** Whether the installed Hermes is the release this Clawboo pins. */
export function managedHermesCurrent(env: NodeJS.ProcessEnv = process.env): boolean {
  return managedHermesVersion(env) === HERMES_RELEASE.version
}

/**
 * Install the pinned release. Reports progress and command output through
 * `onEvent`; resolves with the version and the `hermes` command it installed.
 */
export async function installHermesRelease(
  onEvent: (ev: HermesInstallEvent) => void,
  opts: { signal?: AbortSignal } & HermesInstallDeps = {},
): Promise<{ version: string; command: string }> {
  const doFetch = opts.fetch ?? fetch
  const run = opts.run ?? runCommand
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const env = opts.env ?? process.env
  const platformKey = pmPlatformKey(platform, arch, { musl: opts.musl ?? isMuslLinux() })
  if (!platformKey) {
    throw new HermesInstallError(
      `Hermes ${HERMES_RELEASE.version} has no build for ${platform} ${arch}.`,
      'UNSUPPORTED_PLATFORM',
    )
  }
  const progress = (step: string, message: string) => onEvent({ type: 'progress', step, message })
  const output = (line: string) => onEvent({ type: 'output', line })
  const must = async (
    label: string,
    command: string,
    args: string[],
    extra: { cwd?: string; env?: Record<string, string> } = {},
  ) => {
    const code = await run(command, args, {
      ...extra,
      onLine: output,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (code !== 0)
      throw new HermesInstallError(`${label} failed (exit code ${code}).`, 'STEP_FAILED')
  }
  const dl = {
    fetch: doFetch,
    run,
    env,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.downloadStallMs ? { stallMs: opts.downloadStallMs } : {}),
  }
  // A tarball here has one top folder, dropped; a zip (uv's Windows build) has
  // its files at the top, so nothing is dropped.
  const untar = (archive: string, into: string) =>
    must(
      'Unpacking',
      'tar',
      archive.endsWith('.zip')
        ? ['-xf', archive, '-C', into]
        : ['-xf', archive, '-C', into, '--strip-components', '1'],
    )

  let folder: string
  try {
    folder = newInstallFolder('hermes', HERMES_RELEASE.tag, env)
  } catch (err) {
    throw new HermesInstallError(err instanceof Error ? err.message : String(err), 'RUNTIMES_DIR')
  }
  try {
    const downloads = path.join(folder, '.downloads')
    const src = path.join(folder, 'src')
    const uvDir = path.join(folder, 'toolchain', 'uv')
    const pyDir = path.join(folder, 'toolchain', 'python')
    for (const dir of [downloads, src, uvDir, pyDir])
      await mkdir(dir, { recursive: true, mode: 0o755 })

    progress('download', `Downloading Hermes ${HERMES_RELEASE.version}…`)
    const tarball = path.join(downloads, 'hermes.tar.gz')
    await download(dl, HERMES_RELEASE.tarballUrl, HERMES_RELEASE.tarballSha256, tarball)
    await untar(tarball, src)

    // The toolchain the release pins for itself, read from the checked tarball.
    const lock = JSON.parse(await readFile(path.join(src, 'pm', 'lock.json'), 'utf8')) as unknown
    const toolchain = pinnedToolchain(lock, platformKey)
    const fetchTool = async (name: string, art: PinnedArtifact, into: string): Promise<void> => {
      const file = path.join(downloads, `${name}${art.url.endsWith('.zip') ? '.zip' : '.tar.gz'}`)
      await download(dl, art.url, art.sha256, file)
      await untar(file, into)
    }
    progress(
      'toolchain',
      `Downloading uv ${toolchain.uv.version} and Python ${toolchain.python.version}…`,
    )
    await fetchTool('uv', toolchain.uv, uvDir)
    await fetchTool('python', toolchain.python, pyDir)
    const uv = await locateTool(uvDir, platform === 'win32' ? 'uv.exe' : 'uv')
    const python = hermesPythonPath(folder, platform)
    await must('Checking the Python it runs on', python, ['--version'])

    progress('dependencies', 'Installing Hermes and its locked dependencies…')
    const uvEnv: Record<string, string> = {
      PATH: env['PATH'] ?? '',
      HOME: env['HOME'] ?? '',
      ...(env['SystemRoot'] ? { SystemRoot: env['SystemRoot'] } : {}),
      ...(env['LOCALAPPDATA'] ? { LOCALAPPDATA: env['LOCALAPPDATA'] } : {}),
      ...Object.fromEntries(
        [
          'HTTPS_PROXY',
          'https_proxy',
          'HTTP_PROXY',
          'http_proxy',
          'ALL_PROXY',
          'all_proxy',
          'NO_PROXY',
          'no_proxy',
          'SSL_CERT_FILE',
          'SSL_CERT_DIR',
        ].flatMap((k) => (env[k] ? [[k, env[k]!]] : [])),
      ),
      UV_NO_CONFIG: '1',
      UV_PYTHON_DOWNLOADS: 'never',
      UV_CACHE_DIR: path.join(downloads, 'uv-cache'),
      UV_PROJECT_ENVIRONMENT: path.join(folder, 'venv'),
    }
    await must(
      'Installing the dependencies',
      uv,
      [
        'sync',
        '--frozen',
        '--no-dev',
        '--project',
        src,
        '--python',
        python,
        ...HERMES_RELEASE.extras.flatMap((x) => ['--extra', x]),
      ],
      { env: uvEnv },
    )

    const venvPython =
      platform === 'win32'
        ? path.join(folder, 'venv', 'Scripts', 'python.exe')
        : path.join(folder, 'venv', 'bin', 'python')
    await must('Recording the version', venvPython, [
      '-I',
      path.join(src, 'scripts', 'write_install_stamp.py'),
      '--output',
      path.join(src, 'install-stamp.json'),
      '--commit',
      HERMES_RELEASE.commit,
      '--base-version',
      HERMES_RELEASE.version,
      '--distance',
      '0',
      '--update-mechanism',
      'external',
      '--source',
      'clawboo',
    ])

    const command = hermesVenvCommand(folder, platform)
    let versionLine = ''
    const code = await run(command, ['--version'], {
      env: { ...uvEnv, HERMES_HOME: path.join(downloads, 'check-home') },
      onLine: (line) => {
        if (!versionLine && /Hermes Agent v/.test(line)) versionLine = line
        output(line)
      },
    })
    if (code !== 0 || !versionLine.includes(`v${HERMES_RELEASE.version}`)) {
      throw new HermesInstallError(
        `The installed Hermes did not report version ${HERMES_RELEASE.version}.`,
        'VERIFY_FAILED',
      )
    }

    await rm(downloads, { recursive: true, force: true })
    // The release's own test suite and docs site are not run: about 110 MB less.
    for (const unused of ['tests', 'website']) {
      await rm(path.join(src, unused), { recursive: true, force: true })
    }
    progress('switch', 'Switching to the new install…')
    commitRuntimeInstall(
      'hermes',
      {
        folder,
        version: HERMES_RELEASE.version,
        source: HERMES_RELEASE.tarballUrl,
        interpreter: { path: python, version: toolchain.python.version },
        launchers: { hermes: { command, args: [] } },
      },
      env,
    )
    return { version: HERMES_RELEASE.version, command }
  } catch (err) {
    await discardInstallFolder(folder)
    if (err instanceof HermesInstallError) throw err
    throw new HermesInstallError(err instanceof Error ? err.message : String(err), 'INSTALL_FAILED')
  }
}
