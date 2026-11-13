import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import { PassThrough } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Every process the display manager starts goes through the spawn seam, which is
// replaced by fakes: Xvnc says its display number and serves a real VNC
// handshake on the socket it was told to listen on; the rest just run.
const spawned = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; env: Record<string, string> }[],
  procs: [] as EventEmitter[],
  agentMode: false,
  failXvnc: false,
  nextDisplay: 7,
}))

function rfbServerReply(sock: net.Socket | PassThrough, out: NodeJS.WritableStream): void {
  out.write('RFB 003.008\n')
  out.write(Buffer.from([1, 1]))
  out.write(Buffer.from([0, 0, 0, 0]))
  const init = Buffer.alloc(24 + 5)
  init.writeUInt16BE(1280, 0)
  init.writeUInt16BE(800, 2)
  init.writeUInt32BE(5, 20)
  init.write('agent', 24)
  out.write(init)
  void sock
}

function fakeProc(): EventEmitter & Record<string, unknown> {
  const p = new EventEmitter() as EventEmitter & Record<string, unknown>
  Object.assign(p, {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnfile: 'fake',
    kill: () => {
      p.emit('close', null, 'SIGTERM')
      return true
    },
  })
  spawned.procs.push(p)
  return p
}

vi.mock('../../runtimes/spawner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtimes/spawner')>()),
  spawnAgentProcess: (opts: {
    command: string
    args: readonly string[]
    env: Record<string, string>
  }) => {
    spawned.calls.push({ command: opts.command, args: [...opts.args], env: { ...opts.env } })
    const p = fakeProc()
    if (opts.command.endsWith('Xvnc') && spawned.failXvnc) {
      setTimeout(() => {
        ;(p['stderr'] as PassThrough).write(
          'Xvnc: error while loading shared libraries: libxcvt.so.0: cannot open shared object file\n',
        )
        setTimeout(() => p.emit('close', 127, null), 5)
      }, 5)
    } else if (opts.command.endsWith('Xvnc')) {
      const socketPath = opts.args[opts.args.indexOf('-rfbunixpath') + 1]!
      const number = spawned.nextDisplay++
      if (!spawned.agentMode) {
        const server = net.createServer((sock) => {
          sock.unref()
          rfbServerReply(sock, sock)
        })
        server.unref()
        server.listen(socketPath, () => (p['stdout'] as PassThrough).write(`${number}\n`))
      } else {
        setImmediate(() => (p['stdout'] as PassThrough).write(`${number}\n`))
      }
    } else if (opts.args[0] === '-e') {
      // The relay a server in agent mode reaches the display's socket through.
      setImmediate(() => rfbServerReply(new PassThrough(), p['stdout'] as PassThrough))
    }
    return p
  },
}))
vi.mock('../../agentUser/config', () => ({ isAgentUserMode: () => spawned.agentMode }))
const agentWrites = vi.hoisted(() => [] as { file: string; mode?: number; data: Buffer }[])
vi.mock('../../agentUser/agentFs', () => ({
  agentMkdir: async () => {},
  agentRemove: async () => {},
  agentWriteFile: async (file: string, data: Buffer, opts?: { mode?: number }) => {
    agentWrites.push({ file, data, ...(opts?.mode !== undefined ? { mode: opts.mode } : {}) })
  },
}))
vi.mock('../../agentUser/state', () => ({ agentHomeDir: () => '/var/lib/clawboo-agent' }))

const displays = await import('../displays')

let home: string
const realPlatform = process.platform
const savedHome = process.env['CLAWBOO_HOME']

beforeAll(() => {
  // Short, because a Unix socket path has a length limit and macOS's temp
  // folder is long.
  home = fs.mkdtempSync('/tmp/cbd-')
  process.env['CLAWBOO_HOME'] = home
})
afterAll(() => {
  if (savedHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  spawned.calls.length = 0
  spawned.procs.length = 0
  spawned.agentMode = false
  spawned.failXvnc = false
  spawned.nextDisplay = 7
  agentWrites.length = 0
  displays.setDisplayBinaryLookupForTests((name) =>
    name === 'Xvnc' ? '/opt/tigervnc/Xvnc' : name === 'openbox' ? '/usr/bin/openbox' : null,
  )
})
afterEach(() => {
  displays.stopAllDisplays()
  displays.setDisplayBinaryLookupForTests(null)
  Object.defineProperty(process, 'platform', { value: realPlatform })
  vi.useRealTimers()
})

describe('displaySupport', () => {
  it('is Linux only, needs Xvnc, and can be turned off', () => {
    expect(displays.displaySupport('darwin', {})).toMatchObject({ ok: false })
    expect(displays.displaySupport('win32', {})).toMatchObject({ ok: false })
    expect(displays.displaySupport('linux', { CLAWBOO_AGENT_DISPLAYS: '0' })).toMatchObject({
      ok: false,
    })
    expect(displays.displaySupport('linux', {})).toMatchObject({
      ok: true,
      tools: {
        xvnc: '/opt/tigervnc/Xvnc',
        windowManager: { bin: '/usr/bin/openbox' },
        dbusDaemon: null,
      },
    })
    displays.setDisplayBinaryLookupForTests(() => null)
    expect(displays.displaySupport('linux', {})).toMatchObject({ ok: false, reason: /Xvnc/ })
  })

  it('says which fix fits this machine: the install on x86_64, the package manager on arm64', () => {
    displays.setDisplayBinaryLookupForTests(() => null)
    expect(displays.displaySupport('linux', {}, 'x64')).toMatchObject({
      ok: false,
      code: 'no-xvnc',
      reason: /Install the desktop tools/,
    })
    const arm = displays.displaySupport('linux', {}, 'arm64')
    expect(arm).toMatchObject({ ok: false, code: 'no-xvnc', reason: /package manager/ })
    expect(arm.ok ? '' : arm.reason).not.toMatch(/Install the desktop tools/)
    expect(
      displays.displaySupport('linux', { CLAWBOO_AGENT_DISPLAYS: 'off' }, 'x64'),
    ).toMatchObject({ ok: false, code: 'off' })
    expect(displays.displaySupport('darwin', {}, 'arm64')).toMatchObject({
      ok: false,
      code: 'platform',
    })
  })

  it('names the Debian and Ubuntu package with the missing file, and says the copy needs it', () => {
    const lib = displays.describeStartFailure(
      'Xvnc: error while loading shared libraries: libxshmfence.so.1: cannot open shared object file',
      true,
    )
    expect(lib).toMatch(/lacks libxshmfence\.so\.1/)
    expect(lib).toMatch(/Clawboo's copy of TigerVNC loads from the system/)
    expect(lib).toMatch(/install libxshmfence1, or tigervnc-standalone-server/)
    expect(lib).toMatch(/Other distributions name their packages differently/)
    const keys = displays.describeStartFailure('XKB: Failed to compile keymap', true)
    expect(keys).toMatch(/install x11-xkb-utils and xkb-data/)
    // The xkbcomp warnings Xvnc prints on every start are not the reason.
    expect(
      displays.describeStartFailure(
        '> Warning: Could not resolve keysym XF86CameraAccessEnable\nErrors from xkbcomp are not fatal to the X server\nFatal server error: (EE) something else',
      ),
    ).not.toMatch(/keyboard compiler/)
    // A library no package is known for: still named, with the general fix.
    const other = displays.describeStartFailure(
      'error while loading shared libraries: libfoo.so.3: cannot open shared object file',
    )
    expect(other).toMatch(/lacks libfoo\.so\.3, a library Xvnc loads/)
    expect(other).toMatch(/tigervnc-standalone-server/)
  })

  it('never repeats a failed start in its own words, which name one agent folder', () => {
    const said = displays.describeStartFailure(
      'Xvnc exited: could not open /home/clawboo-agent/desktops/agent-secret-id/vnc.sock',
    )
    expect(said).not.toContain('agent-secret-id')
    expect(said).toMatch(/server log/)
  })
})

describe('acquireDisplay', () => {
  it('starts Xvnc reachable only through its own folder, with a cookie, and a window manager on it', async () => {
    const d = await displays.acquireDisplay('agent-1', 'browser:x')
    expect(d).not.toBeNull()
    expect(d!.display).toBe(7)
    expect([d!.width, d!.height]).toEqual([1280, 800])

    const xvnc = spawned.calls.find((c) => c.command === '/opt/tigervnc/Xvnc')!
    const arg = (flag: string) => xvnc.args[xvnc.args.indexOf(flag) + 1]
    // No TCP at all: neither VNC nor X11.
    expect(arg('-rfbport')).toBe('-1')
    expect(arg('-nolisten')).toBe('tcp')
    expect(arg('-rfbunixmode')).toBe('0600')
    expect(arg('-rfbunixpath')!.startsWith(d!.dir)).toBe(true)
    expect(arg('-auth')).toBe(d!.xauthFile)
    expect(xvnc.args).toContain('-SendCutText=0')

    // The folder is closed to everyone else, and so is the cookie.
    expect(fs.statSync(d!.dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(d!.xauthFile).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(d!.xauthFile).includes(Buffer.from('MIT-MAGIC-COOKIE-1'))).toBe(true)

    // No dbus-daemon here: the bus is named as one that can never exist, so
    // nothing on the display looks for the person's own desktop bus.
    expect(d!.env).toEqual({
      DISPLAY: ':7',
      XAUTHORITY: d!.xauthFile,
      DBUS_SESSION_BUS_ADDRESS: displays.NO_SESSION_BUS,
      NO_AT_BRIDGE: '1',
    })
    const wm = spawned.calls.find((c) => c.command === '/usr/bin/openbox')!
    expect(wm.env['DISPLAY']).toBe(':7')
    expect(wm.env['XAUTHORITY']).toBe(d!.xauthFile)
  })

  it("gives the display's bus and window manager no desktop session, a home in its folder, settings in memory", async () => {
    displays.setDisplayBinaryLookupForTests((name) =>
      name === 'Xvnc'
        ? '/opt/tigervnc/Xvnc'
        : name === 'dbus-daemon'
          ? '/usr/bin/dbus-daemon'
          : name === 'openbox'
            ? '/usr/bin/openbox'
            : null,
    )
    const personHome = process.env['HOME'] ?? '/home/person'
    vi.stubEnv('SESSION_MANAGER', 'local/host:@/tmp/.ICE-unix/1234')
    vi.stubEnv('SSH_AUTH_SOCK', '/run/user/1000/ssh-agent')
    vi.stubEnv('IBUS_ADDRESS', 'unix:path=/run/user/1000/ibus')
    vi.stubEnv('XDG_DATA_DIRS', `${personHome}/.local/share/flatpak/exports/share:/usr/share`)
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0')
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'GNOME')
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus')
    vi.stubEnv('XDG_CONFIG_HOME', '/home/person/.config')
    try {
      const d = await displays.acquireDisplay('agent-1', 'browser:x')
      const bus = spawned.calls.find((c) => c.command === '/usr/bin/dbus-daemon')!
      for (const k of ['WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE']) {
        expect(bus.env[k], k).toBeUndefined()
      }
      expect(bus.env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined()
      expect(bus.env['HOME']).toBe(d!.dir)
      expect(bus.env['XDG_CONFIG_HOME']).toBe(d!.dir)
      expect(bus.env['XDG_RUNTIME_DIR']).toBe(d!.dir)
      expect(bus.env['GSETTINGS_BACKEND']).toBe('memory')
      expect(bus.env['DISPLAY']).toBe(`:${d!.display}`)
      expect(bus.env['XDG_STATE_HOME']).toBe(d!.dir)
      // Nothing of the person's session, and no service folder in their home.
      for (const k of ['SESSION_MANAGER', 'SSH_AUTH_SOCK', 'IBUS_ADDRESS']) {
        expect(bus.env[k], k).toBeUndefined()
      }
      expect(bus.env['XDG_DATA_DIRS']).toBe('/usr/share')
      expect(bus.env['PATH']).toBe(process.env['PATH'])
      // The window manager likewise, and it joins no session manager.
      const wm = spawned.calls.find((c) => c.command === '/usr/bin/openbox')!
      expect(wm.args).toContain('--sm-disable')
      expect(wm.env['SESSION_MANAGER']).toBeUndefined()
      expect(wm.env['HOME']).toBe(d!.dir)
      expect(wm.env['DISPLAY']).toBe(`:${d!.display}`)
      // Programs on the display get the private bus.
      expect(d!.env['DBUS_SESSION_BUS_ADDRESS']).toBe(`unix:path=${d!.dir}/bus`)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('runs Openbox only on a configuration of its own, with nothing that starts a program', async () => {
    const d = await displays.acquireDisplay('agent-1', 'browser:x')
    const wm = spawned.calls.find((c) => c.command === '/usr/bin/openbox')!
    expect(wm.args[0]).toBe('--config-file')
    const rcFile = wm.args[1]!
    expect(rcFile.startsWith(d!.dir + '/')).toBe(true)
    expect(fs.statSync(rcFile).mode & 0o777).toBe(0o600)
    const rc = fs.readFileSync(rcFile, 'utf8')
    // No key bindings, no menu on any click, no action that runs a program.
    expect(rc).toContain('<keyboard></keyboard>')
    expect(rc).not.toMatch(/ShowMenu|Execute|Exit|Reconfigure|Restart/)
    const menuFile = /<file>([^<]+)<\/file>/.exec(rc)![1]!
    expect(menuFile.startsWith(d!.dir + '/')).toBe(true)
    const menu = fs.readFileSync(menuFile, 'utf8')
    expect(menu).not.toMatch(/<item|execute|<menu id="[^"]+"[^/]*>[\s\S]*<menu/i)
  })

  it('uses no window manager but Openbox, whose defaults it can trust', () => {
    displays.setDisplayBinaryLookupForTests((name) =>
      name === 'Xvnc'
        ? '/opt/tigervnc/Xvnc'
        : name === 'twm' || name === 'fluxbox'
          ? `/usr/bin/${name}`
          : null,
    )
    expect(displays.displaySupport('linux', {})).toMatchObject({
      ok: true,
      tools: { windowManager: null },
    })
  })

  it('gives every agent its own display, and one per agent however many hold it', async () => {
    const a1 = await displays.acquireDisplay('agent-1', 'browser:1')
    const a2 = await displays.acquireDisplay('agent-1', 'driver:1')
    const b = await displays.acquireDisplay('agent-2', 'browser:2')
    expect(a2).toBe(a1)
    expect(b).not.toBe(a1)
    expect(b!.dir).not.toBe(a1!.dir)
    expect(b!.xauthFile).not.toBe(a1!.xauthFile)
    expect(spawned.calls.filter((c) => c.command.endsWith('Xvnc'))).toHaveLength(2)
  })

  it('stops a display a while after its last holder lets go, not before', async () => {
    const changes: (number | null)[] = []
    displays.onDisplayChange((_id, d) => changes.push(d ? d.display : null))
    await displays.acquireDisplay('agent-1', 'browser:1')
    await displays.acquireDisplay('agent-1', 'driver:1')
    vi.useFakeTimers()
    displays.releaseDisplay('agent-1', 'browser:1')
    vi.advanceTimersByTime(displays.STOP_GRACE_MS * 2)
    expect(displays.displayFor('agent-1')).not.toBeNull()
    displays.releaseDisplay('agent-1', 'driver:1')
    vi.advanceTimersByTime(displays.STOP_GRACE_MS - 1)
    expect(displays.displayFor('agent-1')).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(displays.displayFor('agent-1')).toBeNull()
    expect(changes).toEqual([7, null])
  })

  it('lets go of every holder of a start that failed, so the next display can stop', async () => {
    spawned.failXvnc = true
    const [a, b] = await Promise.all([
      displays.acquireDisplay('agent-1', 'browser:playwright'),
      displays.acquireDisplay('agent-1', 'browser:chrome-devtools'),
    ])
    expect([a, b]).toEqual([null, null])
    expect(displays.displayHolders('agent-1')).toEqual([])
    // Says which library is missing, for the Screen view.
    expect(displays.displayProblem()).toMatch(/lacks libxcvt\.so\.0/)
  })

  it('takes the place of a display only waiting out its grace when every place is used', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await displays.acquireDisplay(id, 'browser')
    displays.releaseDisplay('a', 'browser')
    expect(displays.displayFor('a')).not.toBeNull() // still in its grace
    const e = await displays.acquireDisplay('e', 'browser')
    expect(e).not.toBeNull()
    expect(displays.displayFor('a')).toBeNull()
    // A display someone still holds is never taken.
    expect(await displays.acquireDisplay('f', 'browser')).toBeNull()
    expect(displays.displayFor('b')).not.toBeNull()
  })

  it('answers null, and starts nothing, where agents get no display', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(await displays.acquireDisplay('agent-1', 'browser:1')).toBeNull()
    expect(spawned.calls).toHaveLength(0)
  })

  it('with agents on their own OS user, writes the cookie as that user and reaches the display through a relay of theirs', async () => {
    spawned.agentMode = true
    const d = await displays.acquireDisplay('agent-1', 'browser:1')
    expect(d).not.toBeNull()
    expect(d!.dir.startsWith('/var/lib/clawboo-agent/desktops/')).toBe(true)
    expect(agentWrites.map((w) => w.file)).toContain(d!.xauthFile)
    for (const w of agentWrites) {
      expect(w.mode).toBe(0o600)
      expect(w.file.startsWith(d!.dir + '/')).toBe(true)
    }
    const relay = spawned.calls.find((c) => c.args[0] === '-e')!
    expect(relay.command).toBe(process.execPath)
    expect(relay.args.at(-1)).toBe(d!.socketPath)
    // Nothing of the display was made by this server in the agent's home.
    expect(fs.existsSync(d!.dir)).toBe(false)
  })
})
