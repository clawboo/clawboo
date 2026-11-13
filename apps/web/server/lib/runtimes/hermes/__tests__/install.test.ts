// Installing the pinned Hermes release into Clawboo's runtimes folder: every
// download is checked against its pinned hash before it is unpacked, the
// toolchain is the one the release's own pm/lock.json pins, dependencies come
// from the release's lock (`uv sync --frozen`), and the install becomes current
// only once Hermes reports the pinned version. A failure leaves nothing behind.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readRuntimeInstall } from '../../../runtimeFolder'
import {
  HermesInstallError,
  installHermesRelease,
  managedHermesCommand,
  type HermesInstallEvent,
} from '../install'
import { HERMES_RELEASE } from '../release'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const UV_BYTES = Buffer.from('uv archive')
const PY_BYTES = Buffer.from('python archive')
const UV_URL =
  'https://github.com/astral-sh/uv/releases/download/0.13.5/uv-aarch64-apple-darwin.tar.gz'
const PY_URL =
  'https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.14.9+20261021-aarch64-apple-darwin-install_only.tar.gz'

/** The uv build the stand-in release's lock pins (a test may pin a zip). */
let uvUrl = UV_URL

function lockJson(): string {
  return JSON.stringify({
    schema: 1,
    packages: {
      uv: {
        version: '0.13.5',
        artifacts: { 'darwin-arm64': { url: uvUrl, sha256: sha(UV_BYTES) } },
      },
      python: {
        version: '3.14.9+20261021',
        artifacts: { 'darwin-arm64': { url: PY_URL, sha256: sha(PY_BYTES) } },
      },
    },
  })
}

describe('installHermesRelease', () => {
  let root: string
  let env: NodeJS.ProcessEnv
  let tarball: Buffer
  let commands: { command: string; args: string[] }[]
  let reportedVersion: string

  beforeEach(() => {
    // Resolved, as the install records it (macOS's temp folder is a link).
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clawboo-hermes-install-')))
    env = {
      ...process.env,
      HOME: path.join(root, 'home'),
      CLAWBOO_HOME: path.join(root, 'data'),
      CLAWBOO_RUNTIMES_DIR: path.join(root, 'runtimes'),
    }
    tarball = Buffer.from('the v0.23.1 tag tarball')
    commands = []
    reportedVersion = 'Hermes Agent v0.23.1 (2026.9.24) · upstream 3b421578'
    uvUrl = UV_URL
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const fetchStub = (over: Record<string, Buffer> = {}): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input)
      const body =
        over[url] ??
        (url === HERMES_RELEASE.tarballUrl
          ? tarball
          : url === uvUrl
            ? UV_BYTES
            : url === PY_URL
              ? PY_BYTES
              : null)
      if (!body) return new Response('missing', { status: 404 })
      return new Response(new Uint8Array(body))
    }) as typeof fetch

  /** Stands in for tar, uv, python and hermes: makes what each would have made. */
  const run = async (
    command: string,
    args: string[],
    opts: { onLine: (l: string) => void },
  ): Promise<number> => {
    commands.push({ command, args })
    if (command === 'curl') {
      writeFileSync(args[args.indexOf('-o') + 1]!, 'not the release')
      return 0
    }
    if (command === 'tar') {
      const into = args[args.indexOf('-C') + 1]!
      const archive = args[args.indexOf('-xf') + 1]!
      const strip = args.includes('--strip-components')
      if (archive.endsWith('hermes.tar.gz')) {
        mkdirSync(path.join(into, 'pm'), { recursive: true })
        mkdirSync(path.join(into, 'scripts'), { recursive: true })
        mkdirSync(path.join(into, 'tests'), { recursive: true })
        writeFileSync(path.join(into, 'pm', 'lock.json'), lockJson())
      } else if (archive.endsWith('uv.zip')) {
        // uv's zip builds have no top folder: dropping one drops the program.
        if (!strip) writeFileSync(path.join(into, 'uv'), '#!/bin/sh\n', { mode: 0o755 })
      } else if (archive.includes('uv.')) {
        // Its tarballs have one, `uv-<target>/`.
        const dir = strip ? into : path.join(into, 'uv-aarch64-apple-darwin')
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, 'uv'), '#!/bin/sh\n', { mode: 0o755 })
      } else {
        mkdirSync(path.join(into, 'bin'), { recursive: true })
        writeFileSync(path.join(into, 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 })
      }
      return 0
    }
    if (command.endsWith(`${path.sep}uv`) && args[0] === 'sync') {
      if (!existsSync(command)) return 127
      const folder = command.slice(0, command.indexOf(`${path.sep}toolchain${path.sep}`))
      const venv = path.join(folder, 'venv')
      mkdirSync(path.join(venv, 'bin'), { recursive: true })
      writeFileSync(path.join(venv, 'bin', 'hermes'), '#!/bin/sh\n', { mode: 0o755 })
      writeFileSync(path.join(venv, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 })
      return 0
    }
    if (command.endsWith(`${path.sep}hermes`) && args[0] === '--version') {
      opts.onLine(reportedVersion)
      return 0
    }
    return 0
  }

  const install = (over: Partial<Parameters<typeof installHermesRelease>[1]> = {}) => {
    const events: HermesInstallEvent[] = []
    const p = installHermesRelease((e) => events.push(e), {
      fetch: fetchStub(),
      run,
      platform: 'darwin',
      arch: 'arm64',
      musl: false,
      env,
      ...over,
    })
    return { p, events }
  }

  it('refuses a release tarball that does not match its pinned hash, and leaves nothing', async () => {
    // The pinned hash is of the real tarball, so these bytes cannot match it.
    const { p } = install()
    await expect(p).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect(commands.some((c) => c.command === 'tar')).toBe(false)
    expect(readdirSync(path.join(root, 'runtimes', 'hermes'))).toEqual([])
    expect(managedHermesCommand(env)).toBeNull()
  })

  describe('with the real tarball hash stood in', () => {
    // The pinned hash cannot be produced from test bytes, so the release's hash is
    // swapped for the stand-in's for these cases only.
    let saved: string
    beforeEach(() => {
      saved = HERMES_RELEASE.tarballSha256
      ;(HERMES_RELEASE as { tarballSha256: string }).tarballSha256 = sha(tarball)
    })
    afterEach(() => {
      ;(HERMES_RELEASE as { tarballSha256: string }).tarballSha256 = saved
    })

    it('installs the pinned toolchain and the locked dependencies, then makes it current', async () => {
      const { p, events } = install()
      const out = await p
      const folder = path.join(root, 'runtimes', 'hermes', 'v0.23.1')
      expect(out).toEqual({
        version: '0.23.1',
        command: path.join(folder, 'venv', 'bin', 'hermes'),
      })

      const uvSync = commands.find((c) => c.args[0] === 'sync')!
      expect(uvSync.command).toBe(path.join(folder, 'toolchain', 'uv', 'uv'))
      expect(uvSync.args).toEqual([
        'sync',
        '--frozen',
        '--no-dev',
        '--project',
        path.join(folder, 'src'),
        '--python',
        path.join(folder, 'toolchain', 'python', 'bin', 'python3'),
        '--extra',
        'anthropic',
        '--extra',
        'mcp',
        '--extra',
        'sms',
      ])
      const stamp = commands.find((c) => c.args.some((a) => a.endsWith('write_install_stamp.py')))!
      expect(stamp.args).toContain(HERMES_RELEASE.commit)
      expect(stamp.args).toContain('external')

      expect(readRuntimeInstall('hermes', env)).toMatchObject({
        version: '0.23.1',
        source: HERMES_RELEASE.tarballUrl,
        launchers: { hermes: { command: out.command, args: [] } },
      })
      expect(managedHermesCommand(env)).toBe(out.command)
      // The downloads and the release's own tests are gone.
      expect(existsSync(path.join(folder, '.downloads'))).toBe(false)
      expect(existsSync(path.join(folder, 'src', 'tests'))).toBe(false)
      expect(
        events.filter((e) => e.type === 'progress').map((e) => (e as { step: string }).step),
      ).toEqual(['download', 'toolchain', 'dependencies', 'switch'])
    })

    it('unpacks a zip with no top folder (uv on Windows) without dropping its program', async () => {
      uvUrl = 'https://github.com/astral-sh/uv/releases/download/0.13.5/uv-aarch64-apple-darwin.zip'
      const { p } = install()
      await expect(p).resolves.toMatchObject({ version: HERMES_RELEASE.version })
      const unzip = commands.find((c) => c.command === 'tar' && c.args[1]!.endsWith('uv.zip'))!
      expect(unzip.args).not.toContain('--strip-components')
      const untar = commands.find(
        (c) => c.command === 'tar' && c.args[1]!.endsWith('hermes.tar.gz'),
      )!
      expect(untar.args).toContain('--strip-components')
    })

    it('refuses a toolchain download that does not match the hash the release pins', async () => {
      const { p } = install({ fetch: fetchStub({ [UV_URL]: Buffer.from('tampered') }) })
      await expect(p).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
      expect(commands.some((c) => c.args[0] === 'sync')).toBe(false)
      expect(managedHermesCommand(env)).toBeNull()
    })

    it('does not switch to an install that reports another version', async () => {
      reportedVersion = 'Hermes Agent vunknown (2026.9.24)'
      const { p } = install()
      await expect(p).rejects.toBeInstanceOf(HermesInstallError)
      await expect(p).rejects.toMatchObject({ code: 'VERIFY_FAILED' })
      expect(managedHermesCommand(env)).toBeNull()
      expect(readdirSync(path.join(root, 'runtimes', 'hermes'))).toEqual([])
    })
  })

  it('says the computer could not reach GitHub when it is offline', async () => {
    const offline = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    }) as unknown as typeof fetch
    const { p } = install({ fetch: offline })
    await expect(p).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(
        /Could not download from github\.com \(ENOTFOUND\).*HTTPS_PROXY/,
      ),
    })
  })

  it('downloads through the proxy the environment names (curl reads it; fetch would not)', async () => {
    const { p } = install({ env: { ...env, HTTPS_PROXY: 'http://proxy.internal:3128' } })
    // The stand-in curl writes nothing, so the hash check fails: what matters is
    // that the download went through curl with https only.
    await expect(p).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    const curl = commands.find((c) => c.command === 'curl')!
    expect(curl.args).toEqual(
      expect.arrayContaining(['-fsSL', '--proto', '=https', HERMES_RELEASE.tarballUrl]),
    )
  })

  it('gives up on a download that stops arriving, and says so', async () => {
    const stalled = (async (_input: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            init?.signal?.addEventListener('abort', () =>
              controller.error(init.signal!.reason ?? new Error('aborted')),
            )
          },
        }),
      )) as unknown as typeof fetch
    const { p } = install({ fetch: stalled, downloadStallMs: 50 })
    await expect(p).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      message: expect.stringMatching(/github\.com \(no data for 1s\)/),
    })
    expect(readdirSync(path.join(root, 'runtimes', 'hermes'))).toEqual([])
  })

  it('has no build for an unsupported machine', async () => {
    const { p } = install({ arch: 'ia32' })
    await expect(p).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' })
  })
})
