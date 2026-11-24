// The desktop tools install: nothing is unpacked or switched to unless the
// download is exactly the pinned release, and a good install becomes the
// current one with `xvnc` and `cua-driver` launchers.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetOperatorSettings } from '../../operatorSettings'
import { readRuntimeInstall } from '../../runtimeFolder'
import { setProgramCheckDepsForTests } from '../screenSettings'
import {
  DesktopToolsError,
  desktopToolsPlan,
  httpsDownload,
  installDesktopTools,
  MIN_RELEASE_AGE_MS,
  releaseAgeRefusal,
  systemXvnc,
  xvncProgram,
  type DownloadProcess,
  type PinnedArtifact,
} from '../tools'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-desktop-tools-'))
  env = {
    ...process.env,
    CLAWBOO_HOME: path.join(root, 'data'),
    CLAWBOO_WORK_DIR: path.join(root, 'work'),
    CLAWBOO_RUNTIMES_DIR: path.join(root, 'runtimes'),
  }
  delete env['HTTPS_PROXY']
  delete env['https_proxy']
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const BODY = Buffer.from('a release archive')
const art = (sha256: string, maxBytes = 1024): PinnedArtifact => ({
  url: 'https://releases.example.test/tool.tar.gz',
  sha256,
  maxBytes,
  publishedAt: '2026-01-01T00:00:00Z',
})
const goodSha = createHash('sha256').update(BODY).digest('hex')
const fetchBody = (body: Buffer) => async () => ({ status: 200, body: Readable.from([body]) })

/** A tar that "unpacks" by making the files each archive is expected to hold. */
function fakeTar(calls: string[][], envs: NodeJS.ProcessEnv[] = []) {
  return async (command: string, args: string[], runEnv: NodeJS.ProcessEnv) => {
    calls.push([command, ...args])
    envs.push(runEnv)
    if (command !== 'tar') return 1
    const dest = args[args.indexOf('-C') + 1]!
    if (dest.endsWith('tigervnc')) {
      fs.mkdirSync(path.join(dest, 'usr', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'usr', 'bin', 'Xvnc'), '#!/bin/sh\n', { mode: 0o755 })
    } else {
      fs.writeFileSync(path.join(dest, 'cua-driver'), '#!/bin/sh\n', { mode: 0o755 })
    }
    return 0
  }
}

describe('desktop tools install', () => {
  it('plans TigerVNC on x86_64 only and Cua Driver on both, on Linux only', () => {
    expect(desktopToolsPlan('linux', 'x64')).toMatchObject({
      tigervnc: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      cuaDriver: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(desktopToolsPlan('linux', 'arm64').tigervnc).toBeNull()
    expect(desktopToolsPlan('linux', 'arm64').cuaDriver).not.toBeNull()
    expect(desktopToolsPlan('darwin', 'arm64')).toEqual({ tigervnc: null, cuaDriver: null })
  })

  it('refuses a download that is not the pinned release, and installs nothing', async () => {
    const calls: string[][] = []
    await expect(
      installDesktopTools({
        env,
        download: fetchBody(Buffer.from('something else')),
        run: fakeTar(calls),
        systemXvnc: () => null,
        plan: { tigervnc: art(goodSha), cuaDriver: null },
      }),
    ).rejects.toMatchObject({ code: 'CHECKSUM' })
    expect(calls.filter((c) => c[0] === 'tar')).toEqual([])
    expect(readRuntimeInstall('desktop', env)).toBeNull()
  })

  it('refuses a download larger than the release, before reading it', async () => {
    await expect(
      installDesktopTools({
        env,
        download: fetchBody(Buffer.alloc(4096)),
        run: fakeTar([]),
        plan: { tigervnc: null, cuaDriver: art(goodSha, 100) },
      }),
    ).rejects.toBeInstanceOf(DesktopToolsError)
    expect(readRuntimeInstall('desktop', env)).toBeNull()
  })

  it('unpacks without the archive owners and makes both launchers current', async () => {
    const calls: string[][] = []
    const done = await installDesktopTools({
      env,
      download: fetchBody(BODY),
      run: fakeTar(calls),
      systemXvnc: () => null,
      plan: { tigervnc: { ...art(goodSha), stripPrefix: 'tigervnc-x' }, cuaDriver: art(goodSha) },
    })
    const tars = calls.filter((c) => c[0] === 'tar')
    expect(tars).toHaveLength(2)
    for (const t of tars) expect(t).toContain('--no-same-owner')
    expect(tars[0]).toEqual(expect.arrayContaining(['--strip-components=1', 'tigervnc-x']))
    const record = readRuntimeInstall('desktop', env)
    expect(record?.launchers['xvnc']?.command).toBe(done.tigervnc)
    expect(record?.launchers['cua-driver']?.command).toBe(done.cuaDriver)
    // The archives themselves are not kept.
    expect(fs.readdirSync(done.folder).sort()).toEqual(['cua-driver', 'tigervnc'])
  })

  it('downloads through curl when a proxy is set, streamed, with no curlrc and a scrubbed environment', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const curl = (args: string[], curlEnv: NodeJS.ProcessEnv): DownloadProcess => {
      calls.push({ args, env: curlEnv })
      return { stdout: Readable.from([BODY]), exited: Promise.resolve(0), kill: () => {} }
    }
    const done = await installDesktopTools({
      env: {
        ...env,
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        CURL_HOME: '/somewhere/else',
        TAR_OPTIONS: '--to-command=sh',
      },
      download: () => {
        throw new Error('a direct download must not be used behind a proxy')
      },
      curl,
      run: fakeTar([]),
      plan: { tigervnc: null, cuaDriver: art(goodSha) },
    })
    expect(done.cuaDriver).not.toBeNull()
    expect(calls).toHaveLength(1)
    const { args, env: curlEnv } = calls[0]!
    // `-q` only works as the very first argument.
    expect(args[0]).toBe('-q')
    expect(args).toEqual(expect.arrayContaining(['--proto', '=https', '--proto-redir', '=https']))
    // To standard output, through Clawboo's own size check, never straight to a file.
    expect(args).not.toContain('-o')
    expect(curlEnv['HTTPS_PROXY']).toBe('http://proxy.example.test:3128')
    expect(curlEnv['CURL_HOME']).toBeUndefined()
    expect(curlEnv['TAR_OPTIONS']).toBeUndefined()
  })

  it('stops a proxy download at the size cap, however long the response runs', async () => {
    let killed = false
    let sent = 0
    const endless = new Readable({
      read() {
        sent += 64
        this.push(Buffer.alloc(64))
      },
    })
    const curl = (): DownloadProcess => ({
      stdout: endless,
      exited: new Promise(() => {}),
      kill: () => {
        killed = true
        endless.destroy()
      },
    })
    await expect(
      installDesktopTools({
        env: { ...env, HTTPS_PROXY: 'http://proxy.example.test:3128' },
        curl,
        run: fakeTar([]),
        plan: { tigervnc: null, cuaDriver: art(goodSha, 1000) },
      }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    expect(killed).toBe(true)
    // Stopped near the cap (stream buffers read a little ahead), not left running.
    expect(sent).toBeLessThan(1024 * 1024)
    expect(readRuntimeInstall('desktop', env)).toBeNull()
  })

  it('gives up a download that keeps trickling past its deadline', async () => {
    const trickle = async () => {
      const body = new Readable({
        read() {
          setTimeout(() => this.push(Buffer.alloc(1)), 5)
        },
      })
      return { status: 200, body }
    }
    await expect(
      installDesktopTools({
        env,
        download: trickle,
        run: fakeTar([]),
        deadlineMs: 100,
        plan: { tigervnc: null, cuaDriver: art(goodSha, 1_000_000) },
      }),
    ).rejects.toThrow(/took too long/)
    expect(readRuntimeInstall('desktop', env)).toBeNull()
  })

  it('runs tar with PATH alone, so TAR_OPTIONS from the server cannot change the unpack', async () => {
    const envs: NodeJS.ProcessEnv[] = []
    await installDesktopTools({
      env: { ...env, TAR_OPTIONS: '--to-command=sh' },
      download: fetchBody(BODY),
      run: fakeTar([], envs),
      plan: { tigervnc: null, cuaDriver: art(goodSha) },
    })
    expect(envs).toHaveLength(1)
    expect(envs[0]!['TAR_OPTIONS']).toBeUndefined()
    expect(envs[0]!['PATH']).toBe(env['PATH'])
  })

  it('refuses a download that is not https, and does not install from it', async () => {
    await expect(
      httpsDownload('http://releases.example.test/x.tar.gz', new AbortController().signal),
    ).rejects.toThrow(/http: was refused/)
    await expect(
      installDesktopTools({
        env,
        download: async () => ({ status: 404, body: Readable.from([]) }),
        run: fakeTar([]),
        plan: { tigervnc: null, cuaDriver: art(goodSha) },
      }),
    ).rejects.toThrow(/HTTP 404/)
    expect(readRuntimeInstall('desktop', env)).toBeNull()
  })

  it("counts the system's Xvnc only when it is TigerVNC's", () => {
    const on = (paths: Record<string, string>) => (name: string) => paths[name] ?? null
    const tiger = (files: string[]) => (file: string) => files.includes(file)
    expect(systemXvnc(on({ Xtigervnc: '/usr/bin/Xtigervnc' }), tiger(['/usr/bin/Xtigervnc']))).toBe(
      '/usr/bin/Xtigervnc',
    )
    expect(systemXvnc(on({ Xvnc: '/usr/bin/Xvnc' }), tiger(['/usr/bin/Xvnc']))).toBe(
      '/usr/bin/Xvnc',
    )
    // An Xvnc that is TightVNC's, KasmVNC's or TurboVNC's does not count.
    expect(systemXvnc(on({ Xvnc: '/usr/bin/Xvnc' }), tiger([]))).toBeNull()
    expect(systemXvnc(on({}), tiger([]))).toBeNull()
  })

  it("downloads no TigerVNC where the system's own Xvnc is there to be used", async () => {
    const urls: string[] = []
    const fetchLogged = async (url: string) => {
      urls.push(url)
      return { status: 200, body: Readable.from([BODY]) }
    }
    const done = await installDesktopTools({
      env,
      download: fetchLogged,
      run: fakeTar([]),
      systemXvnc: () => '/usr/bin/Xvnc',
      plan: {
        tigervnc: { ...art(goodSha), url: 'https://releases.example.test/tigervnc.tar.gz' },
        cuaDriver: art(goodSha),
      },
    })
    expect(urls).toEqual(['https://releases.example.test/tool.tar.gz'])
    expect(done.tigervnc).toBeNull()
    expect(readRuntimeInstall('desktop', env)?.launchers['xvnc']).toBeUndefined()
  })

  it('lets a second install join the one running rather than race it', async () => {
    let fetches = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slowFetch = async () => {
      fetches++
      await gate
      return { status: 200, body: Readable.from([BODY]) }
    }
    const deps = {
      env,
      download: slowFetch,
      run: fakeTar([]),
      plan: { tigervnc: null, cuaDriver: art(goodSha) },
    }
    const first = installDesktopTools(deps)
    const second = installDesktopTools(deps)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(fetches).toBe(1)
    expect(b.folder).toBe(a.folder)
    expect(readRuntimeInstall('desktop', env)?.launchers['cua-driver']?.command).toBe(a.cuaDriver)
  })
})

const DAY = 24 * 60 * 60_000

describe('pinned releases are at least 14 days old', () => {
  it('pins every release Clawboo installs to one published 14 days ago or more', () => {
    for (const plan of [desktopToolsPlan('linux', 'x64'), desktopToolsPlan('linux', 'arm64')]) {
      for (const pinned of [plan.tigervnc, plan.cuaDriver]) {
        if (!pinned) continue
        expect(Date.now() - Date.parse(pinned.publishedAt)).toBeGreaterThanOrEqual(
          MIN_RELEASE_AGE_MS,
        )
      }
    }
  })

  it('installs nothing from a release younger than that, or one whose date cannot be read', async () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    for (const publishedAt of [new Date(now - 13 * DAY).toISOString(), 'soon']) {
      let downloads = 0
      await expect(
        installDesktopTools({
          env,
          download: async () => {
            downloads += 1
            return { status: 200, body: Readable.from([BODY]) }
          },
          run: fakeTar([]),
          systemXvnc: () => null,
          now: () => now,
          plan: { tigervnc: null, cuaDriver: { ...art(goodSha), publishedAt } },
        }),
      ).rejects.toMatchObject({ code: 'TOO_NEW' })
      expect(downloads).toBe(0)
    }
    expect(
      releaseAgeRefusal(
        { ...art(goodSha), publishedAt: new Date(now - 14 * DAY).toISOString() },
        'X',
        now,
      ),
    ).toBeNull()
  })
})

describe("the administrator's download switches", () => {
  it('downloads nothing when downloads are turned off', async () => {
    let downloads = 0
    await expect(
      installDesktopTools({
        env,
        download: async () => {
          downloads += 1
          return { status: 200, body: Readable.from([BODY]) }
        },
        run: fakeTar([]),
        systemXvnc: () => null,
        installRefusal: () => 'Downloading the desktop tools is turned off.',
        plan: { tigervnc: art(goodSha), cuaDriver: art(goodSha) },
      }),
    ).rejects.toMatchObject({ code: 'TURNED_OFF' })
    expect(downloads).toBe(0)
  })

  it('never downloads a tool whose program the administrator named', async () => {
    const urls: string[] = []
    const calls: string[][] = []
    const done = await installDesktopTools({
      env,
      download: async (url) => {
        urls.push(url)
        return { status: 200, body: Readable.from([BODY]) }
      },
      run: fakeTar(calls),
      systemXvnc: () => null,
      downloadRefusal: (tool) => (tool === 'tigervnc' ? 'named by the administrator' : null),
      plan: {
        tigervnc: { ...art(goodSha), url: 'https://releases.example.test/tigervnc.tar.gz' },
        cuaDriver: { ...art(goodSha), url: 'https://releases.example.test/cua.tar.gz' },
      },
    })
    expect(urls).toEqual(['https://releases.example.test/cua.tar.gz'])
    // The system's Xvnc was not even looked for (looking runs it): TigerVNC is named.
    let looked = 0
    await installDesktopTools({
      env,
      download: fetchBody(BODY),
      run: fakeTar([]),
      systemXvnc: () => {
        looked += 1
        return null
      },
      downloadRefusal: (tool) => (tool === 'tigervnc' ? 'named by the administrator' : null),
      plan: { tigervnc: art(goodSha), cuaDriver: art(goodSha) },
    })
    expect(looked).toBe(0)
    expect(done.tigervnc).toBeNull()
    expect(done.cuaDriver).not.toBeNull()
    // Both named: nothing to install, and it says why.
    await expect(
      installDesktopTools({
        env,
        download: fetchBody(BODY),
        run: fakeTar([]),
        systemXvnc: () => null,
        downloadRefusal: () => 'named by the administrator',
        plan: { tigervnc: art(goodSha), cuaDriver: art(goodSha) },
      }),
    ).rejects.toThrow(/Nothing to install: named by the administrator/)
  })
})

describe('xvncProgram', () => {
  const onWindows = process.platform === 'win32'
  let dir: string
  const saved = process.env['CLAWBOO_XVNC_PATH']
  /** A filesystem where everything is root's and closed: only the trust check is stood in for. */
  const trusted = (file: string) => ({
    lstat: (p: string) =>
      ({
        uid: 0,
        mode: 0o755,
        isFile: () => p === file,
        isDirectory: () => p !== file,
      }) as fs.Stats,
    realpath: (p: string) => p,
    canExecute: () => true,
    uid: 0,
  })
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawboo-xvnc-'))
    resetOperatorSettings()
  })
  afterEach(() => {
    setProgramCheckDepsForTests(null)
    if (saved === undefined) delete process.env['CLAWBOO_XVNC_PATH']
    else process.env['CLAWBOO_XVNC_PATH'] = saved
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const script = (name: string, says: string) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, `#!/bin/sh\necho '${says}' >&2\n`, { mode: 0o755 })
    return file
  }

  it.skipIf(onWindows)("runs the Xvnc the administrator named, and only TigerVNC's", () => {
    const tiger = script('Xvnc', 'Xvnc TigerVNC 1.16.2 - built Mar 26 2026')
    process.env['CLAWBOO_XVNC_PATH'] = tiger
    setProgramCheckDepsForTests(trusted(tiger))
    expect(xvncProgram()).toEqual({ path: tiger, problem: null })

    const other = script('Xvnc-tight', 'Xvnc TightVNC 1.3.10')
    process.env['CLAWBOO_XVNC_PATH'] = other
    setProgramCheckDepsForTests(trusted(other))
    expect(xvncProgram()).toMatchObject({
      path: null,
      problem: expect.stringMatching(/not TigerVNC/),
    })
  })

  it.skipIf(onWindows)(
    'runs no other Xvnc in place of a named one that fails its check, and never runs that one',
    () => {
      const marker = path.join(dir, 'ran')
      const file = path.join(dir, 'Xvnc')
      fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\necho 'Xvnc TigerVNC 1.16.2' >&2\n`, {
        mode: 0o755,
      })
      process.env['CLAWBOO_XVNC_PATH'] = file
      // The real check: a temporary folder is one others can write.
      const found = xvncProgram()
      expect(found.path).toBeNull()
      expect(found.problem).toMatch(/can be changed by a user|a folder above|is a link/)
      expect(fs.existsSync(marker)).toBe(false)
    },
  )
})
