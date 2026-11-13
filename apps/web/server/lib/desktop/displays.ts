// A display of its own for each agent, on Linux.
//
// Each agent that opens a browser (or a desktop driver) gets a virtual X
// display: TigerVNC's `Xvnc`, which is an X server and a VNC server in one
// process. The agent's browser opens on it, so do any Linux apps the agent
// starts, and a person can watch it or take it over from the dashboard.
//
// WHO CAN REACH IT
//
// - Drawing on it (an X client): only a program that has the display's cookie.
//   The authority file sits in the display's own folder, 0700, owned by whoever
//   runs the agent's programs (the agent user when agents run as their own OS
//   user, else the server's user).
// - Seeing or driving its screen (VNC): only through a Unix socket in that same
//   folder, mode 0600, and no TCP port at all. The Clawboo server is its one
//   client: directly when it runs the agents' programs itself, and through a
//   small relay started as the agent user when it does not (it cannot enter the
//   agent user's folders). Watchers get pictures from the server and never a
//   VNC connection of their own.
//
// All agents share one agent user today, so one agent's programs can reach
// another agent's display. These walls keep the displays from other local
// users and from the server's own secrets, not agents from each other.
//
// LIFETIME. A display exists while something holds it: the agent's browser, its
// desktop driver, or a person who started it by hand. When the last holder lets
// go it stops after `STOP_GRACE_MS`, so a browser closed and reopened a moment
// later finds its display still there. Every process here is registered with the
// runtime child registry, so a server shutdown stops it, and the next boot reaps
// one a crash left behind.

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'

import { agentMkdir, agentRemove, agentWriteFile } from '../agentUser/agentFs'
import { isAgentUserMode } from '../agentUser/config'
import { agentHomeDir } from '../agentUser/state'
import { findExecutable } from '../platform'
import { buildChildEnv } from '../runtimes/childEnv'
import { killProcessTree } from '../runtimes/killTree'
import { spawnAgentProcess, type AgentProcess } from '../runtimes/spawner'
import { registerRuntimeChild, unregisterRuntimeChild } from '../runtimes/subprocess'
import { RfbClient } from './rfb'
import { desktopToolsPlan, markDesktopToolsInUse, ownedXvnc, systemXvnc } from './tools'
import { makeXauthority } from './xauth'

const log = createLogger('agent-displays')

/** How long a display outlives its last holder. */
export const STOP_GRACE_MS = 30_000

/** How long Xvnc may take to come up. */
const START_TIMEOUT_MS = 15_000

/** No more displays than browsers: each display exists for an agent's browser or
 *  driver, and those are capped by the same number. */
const MAX_DISPLAYS = Number(process.env['CLAWBOO_MAX_AGENT_BROWSERS']) || 4

/**
 * The window manager, when Openbox is installed: and only Openbox, started with
 * a configuration Clawboo writes for the display.
 *
 * A window manager's own menus and keys start programs: a right click on the
 * desktop offers a terminal in most of them. Whoever takes over an agent's
 * screen would get a shell as the agent's user from there. Openbox reads its
 * whole configuration from one file, so this one has no menu, no key binding
 * and no mouse binding that starts anything: windows can be focused, moved,
 * maximized and closed, and that is all. Other window managers are not used:
 * their defaults cannot be trusted the same way.
 */
const WINDOW_MANAGER = 'openbox'

const OPENBOX_MENU = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="" />
</openbox_menu>
`

/** Text as XML character data: a path with `&` or `<` in it must not make the
 *  file unreadable, which would have Openbox fall back to a configuration with
 *  menus (the system's, or one the agent user wrote in its own home). */
function xmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function openboxConfig(menuFile: string): string {
  const press = (context: string) =>
    `    <context name="${context}">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Middle" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Right" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
    </context>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy></placement>
  <theme><titleLayout>LMC</titleLayout></theme>
  <desktops><number>1</number></desktops>
  <keyboard></keyboard>
  <mouse>
    <dragThreshold>4</dragThreshold>
    <doubleClickTime>300</doubleClickTime>
${press('Client')}
${press('Frame')}
    <context name="Titlebar">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Maximize"><mousebind button="Left" action="Click"><action name="ToggleMaximize"/></mousebind></context>
    <context name="Close"><mousebind button="Left" action="Click"><action name="Close"/></mousebind></context>
  </mouse>
  <menu><file>${xmlText(menuFile)}</file></menu>
  <applications><application type="normal"><maximized>true</maximized></application></applications>
</openbox_config>
`
}

/** The relay a display's VNC socket is reached through when the agent user owns
 *  it: stdin to the socket, the socket to stdout, and gone when either ends. */
const RELAY_SCRIPT = [
  "const s=require('net').connect(process.argv[1]);",
  'process.stdin.pipe(s);s.pipe(process.stdout);',
  "s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));",
  "process.stdin.on('end',()=>s.end());",
].join('')

export interface DisplayTools {
  xvnc: string
  /** Openbox, when installed. */
  windowManager: { bin: string } | null
  dbusDaemon: string | null
}

/** Why agents get no displays: not Linux, turned off, or no Xvnc to run. */
export type DisplayUnavailable = 'platform' | 'off' | 'no-xvnc'

export type DisplaySupport =
  { ok: true; tools: DisplayTools } | { ok: false; code: DisplayUnavailable; reason: string }

/**
 * The bus address a program on an agent's display gets when the display has no
 * private bus of its own. It can never exist (`/dev/null` is no directory), so
 * nothing on the display falls back to finding the person's own desktop bus,
 * which a desktop driver would otherwise adopt and switch accessibility on for.
 */
export const NO_SESSION_BUS = 'unix:path=/dev/null/clawboo-no-session-bus'

/**
 * Where a program is. Xvnc from the system's own package comes first (its
 * package brings the libraries it loads), then the one Clawboo installed into
 * its runtimes folder. Overridable by tests.
 */
const defaultLookup = (name: string): string | null =>
  name === 'Xvnc' ? (systemXvnc() ?? ownedXvnc()) : findExecutable(name)
let findBinary: (name: string) => string | null = defaultLookup

export function setDisplayBinaryLookupForTests(fn: ((name: string) => string | null) | null): void {
  findBinary = fn ?? defaultLookup
}

/** Why the last display failed to start, in words a person can act on, or null. */
let lastProblem: string | null = null

/** Why agents' displays are not starting, or null when the last one did. */
export function displayProblem(): string | null {
  return lastProblem
}

/**
 * The Debian and Ubuntu packages that hold what TigerVNC's own Linux build
 * (Clawboo's copy) loads from the system. Other distributions name them
 * differently, so a sentence always names the file too. Clawboo installs none
 * of them.
 */
const DEBIAN_PACKAGE_OF: Readonly<Record<string, string>> = {
  'libxcvt.so.0': 'libxcvt0',
  'libxshmfence.so.1': 'libxshmfence1',
  'libgbm.so.1': 'libgbm1',
}

/** The distribution's own TigerVNC, which brings everything its Xvnc needs. */
const WHOLE_PACKAGE =
  'or tigervnc-standalone-server, whose own Xvnc brings all it needs and is then used instead'

/**
 * A start failure as a sentence: a missing library is named, with the package
 * that holds it on Debian and Ubuntu, since that is the one fix a person can
 * make. `owned` says the Xvnc that failed is Clawboo's copy of TigerVNC.
 */
export function describeStartFailure(message: string, owned = false): string {
  const xvnc = owned ? "Clawboo's copy of TigerVNC" : 'Xvnc'
  const lib = /error while loading shared libraries: ([\w.+-]+\.so[\w.]*)/.exec(message)?.[1]
  if (lib) {
    const pkg = DEBIAN_PACKAGE_OF[lib]
    const fix = pkg
      ? `On Debian or Ubuntu, install ${pkg}, ${WHOLE_PACKAGE}. Other distributions name their packages differently.`
      : `Install the package that provides it with your package manager, or, on Debian or Ubuntu, ${WHOLE_PACKAGE.slice(3)}.`
    return `Xvnc cannot start: this system lacks ${lib}, a library ${xvnc} loads from the system. ${fix}`
  }
  // Fatal keyboard errors only: Xvnc prints xkbcomp warnings on every start,
  // and they say nothing about why one failed.
  if (
    /Failed to compile keymap|Keyboard initiali[sz]ation failed|Error loading keymap|xkbcomp[^\n]*(not found|No such file)|Couldn'?t (load|open) XKB/i.test(
      message,
    )
  ) {
    return `Xvnc cannot start: ${xvnc} runs the system's keyboard compiler (xkbcomp) with its keyboard data. On Debian or Ubuntu, install x11-xkb-utils and xkb-data, ${WHOLE_PACKAGE}. Other distributions name their packages differently.`
  }
  // Not the message itself: it names one agent's display folder, and this
  // sentence is shown on every agent's screen.
  return "Xvnc did not start for an agent's screen. The server log says why."
}

/** The only variables a display's own services keep from the server's. */
const DISPLAY_SERVICE_ENV = /^(PATH|LANG|LANGUAGE|LC_\w+|TZ|USER|LOGNAME)$/

/** A search path with every entry under `home` taken out, or null when none is left. */
function systemDirsOnly(value: string | undefined, home: string | undefined): string | null {
  if (!value) return null
  const keep = value
    .split(':')
    .filter((d) => path.isAbsolute(d) && !(home && (d === home || d.startsWith(home + '/'))))
  return keep.length > 0 ? keep.join(':') : null
}

/**
 * The environment of the services that run a display: its private session
 * bus and its window manager. Built up from a short list, never handed the
 * server's own environment. The bus starts services on demand (the
 * accessibility bus, a settings store, a portal) with its own environment,
 * and with the server user's home and desktop session they would act on that
 * person's desktop: at-spi2-core writes the screen-reader setting through
 * GSettings, which would reach the person's dconf and start a screen reader at
 * their next login; a window manager handed `SESSION_MANAGER` joins the
 * person's session. So: a home and XDG folders inside the display's own
 * folder, data folders outside the person's home, nothing from their session
 * (input methods, ssh and gpg agents, sound), and settings kept in memory.
 */
export function displayServiceEnv(
  base: Record<string, string | undefined>,
  displayEnv: Record<string, string>,
  dir: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string' && DISPLAY_SERVICE_ENV.test(k)) out[k] = v
  }
  const dataDirs = systemDirsOnly(base['XDG_DATA_DIRS'], base['HOME'])
  const configDirs = systemDirsOnly(base['XDG_CONFIG_DIRS'], base['HOME'])
  return {
    ...out,
    ...(dataDirs ? { XDG_DATA_DIRS: dataDirs } : {}),
    ...(configDirs ? { XDG_CONFIG_DIRS: configDirs } : {}),
    ...displayEnv,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_DATA_HOME: dir,
    XDG_CACHE_HOME: dir,
    XDG_STATE_HOME: dir,
    XDG_RUNTIME_DIR: dir,
    GSETTINGS_BACKEND: 'memory',
  }
}

/**
 * Whether agents get displays here, and with what. Linux only: a Mac or a
 * Windows machine already has a real screen, and its agents keep today's
 * browser, with a live view of the browser itself.
 * `CLAWBOO_AGENT_DISPLAYS=0` turns displays off on Linux too.
 */
export function displaySupport(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  arch: string = process.arch,
): DisplaySupport {
  if (platform !== 'linux') {
    return {
      ok: false,
      code: 'platform',
      reason: 'Agents get a display of their own on Linux only.',
    }
  }
  const setting = (env['CLAWBOO_AGENT_DISPLAYS'] ?? '').trim().toLowerCase()
  if (setting === '0' || setting === 'off' || setting === 'false') {
    return {
      ok: false,
      code: 'off',
      reason: 'Agent displays are turned off (CLAWBOO_AGENT_DISPLAYS).',
    }
  }
  const xvnc = findBinary('Xvnc')
  if (!xvnc) {
    // Clawboo installs TigerVNC's own build, which exists for x86_64 only.
    const fix = desktopToolsPlan(platform, arch).tigervnc
      ? 'Install the desktop tools to give each agent one.'
      : "Install TigerVNC's Xvnc with your package manager to give each agent one."
    return {
      ok: false,
      code: 'no-xvnc',
      reason: `No Xvnc was found, so agents' browsers run without a display of their own. ${fix}`,
    }
  }
  const wm = findBinary(WINDOW_MANAGER)
  return {
    ok: true,
    tools: { xvnc, windowManager: wm ? { bin: wm } : null, dbusDaemon: findBinary('dbus-daemon') },
  }
}

/** `WIDTHxHEIGHT` from `CLAWBOO_AGENT_DISPLAY_SIZE`, 1280x800 by default. */
export function displayGeometry(env: NodeJS.ProcessEnv = process.env): {
  width: number
  height: number
} {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec((env['CLAWBOO_AGENT_DISPLAY_SIZE'] ?? '').trim())
  const width = m ? Number(m[1]) : 1280
  const height = m ? Number(m[2]) : 800
  return {
    width: Math.min(Math.max(width, 640), 3840),
    height: Math.min(Math.max(height, 480), 2160),
  }
}

export interface AgentDisplay {
  agentId: string
  /** The X display number: `:N`. */
  display: number
  /** The display's own folder (0700). */
  dir: string
  xauthFile: string
  socketPath: string
  /** The display's private session bus, when `dbus-daemon` is installed. */
  busAddress: string | null
  width: number
  height: number
  /** The server's VNC connection to this display. */
  rfb: RfbClient
  /** What a program needs in its environment to open on this display. */
  env: Record<string, string>
}

interface Entry {
  display: AgentDisplay | null
  starting: Promise<AgentDisplay | null> | null
  holders: Set<string>
  stopTimer: NodeJS.Timeout | null
  procs: AgentProcess[]
}

const entries = new Map<string, Entry>()
const events = new EventEmitter()
events.setMaxListeners(0)

/** Called whenever an agent's display starts or stops. Returns an unsubscribe. */
export function onDisplayChange(
  listener: (agentId: string, display: AgentDisplay | null) => void,
): () => void {
  events.on('change', listener)
  return () => events.off('change', listener)
}

/** The agent's running display, or null. */
export function displayFor(agentId: string): AgentDisplay | null {
  return entries.get(agentId)?.display ?? null
}

/** The display's folder for an agent: hashed, because an agent id is not
 *  guaranteed to be a safe path segment. */
export function displayDirFor(agentId: string, inAgentSpace: boolean = isAgentUserMode()): string {
  const stem = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  const root = inAgentSpace ? agentHomeDir() : resolveClawbooDir()
  return path.join(root, 'desktops', stem)
}

function track(entry: Entry, proc: AgentProcess): AgentProcess {
  entry.procs.push(proc)
  registerRuntimeChild(proc)
  proc.once('close', () => unregisterRuntimeChild(proc))
  // A process that never started reports it as an 'error'; without a listener
  // that would reach the process as an uncaught exception.
  proc.on('error', (err: Error) => log.warn({ err: err.message }, 'a display process failed'))
  return proc
}

function stopProcs(entry: Entry): void {
  for (const proc of entry.procs.reverse()) {
    try {
      killProcessTree(proc)
    } catch {
      // Best effort: one stubborn process must not keep the rest running.
    }
  }
  entry.procs = []
}

/** Read the display number Xvnc writes to its stdout (`-displayfd 1`). */
function readDisplayNumber(proc: AgentProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const done = (fn: () => void) => {
      clearTimeout(timer)
      proc.stdout?.off('data', onOut)
      proc.off('close', onClose)
      fn()
    }
    const onOut = (chunk: Buffer | string) => {
      out += chunk.toString()
      // Only a whole line: "1" from a "10" split across two reads is not it.
      const m = /^(\d+)\r?\n/m.exec(out)
      if (m) done(() => resolve(Number(m[1])))
    }
    const onClose = (code: number | null) =>
      done(() =>
        reject(new Error(`Xvnc exited (${code}) before its display was ready: ${err.slice(-400)}`)),
      )
    const timer = setTimeout(
      () => done(() => reject(new Error('Xvnc did not say its display number in time'))),
      timeoutMs,
    )
    proc.stdout?.on('data', onOut)
    proc.stderr?.on('data', (c: Buffer | string) => {
      err = (err + c.toString()).slice(-4000)
    })
    proc.once('close', onClose)
  })
}

/** Connect the server's VNC session to the display's socket. */
async function connectRfb(entry: Entry, socketPath: string): Promise<RfbClient> {
  if (isAgentUserMode()) {
    // The server cannot enter the agent user's folder, so a process of that
    // user connects for it and relays the bytes over its stdin and stdout.
    const relay = track(
      entry,
      spawnAgentProcess({
        kind: 'browser',
        command: process.execPath,
        args: ['-e', RELAY_SCRIPT, socketPath],
        env: buildChildEnv({}),
        // stderr is never read, and a pipe nobody reads stops its writer once full.
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      }),
    )
    if (!relay.stdout || !relay.stdin) throw new Error('the display relay has no pipes')
    const client = new RfbClient({ input: relay.stdout, output: relay.stdin })
    await client.start()
    return client
  }
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const sock = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(socketPath)
        s.once('connect', () => resolve(s))
        s.once('error', reject)
      })
      const client = new RfbClient({ input: sock, output: sock })
      await client.start()
      return client
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not connect to the display')
}

async function startDisplay(
  agentId: string,
  entry: Entry,
  tools: DisplayTools,
): Promise<AgentDisplay> {
  const asAgent = isAgentUserMode()
  const dir = displayDirFor(agentId, asAgent)
  const xauthFile = path.join(dir, 'Xauthority')
  const socketPath = path.join(dir, 'vnc.sock')
  const { file: xauth } = makeXauthority()
  const wmConfig = path.join(dir, 'openbox-rc.xml')
  const wmMenu = path.join(dir, 'openbox-menu.xml')
  // Made by whoever runs the display, 0700, so only that user may enter it.
  if (asAgent) {
    await agentMkdir(path.dirname(dir))
    await agentMkdir(dir)
    await agentRemove(socketPath)
    await agentWriteFile(xauthFile, xauth, { mode: 0o600 })
    if (tools.windowManager) {
      await agentWriteFile(wmMenu, OPENBOX_MENU, { mode: 0o600 })
      await agentWriteFile(wmConfig, openboxConfig(wmMenu), { mode: 0o600 })
    }
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    // A stale socket from a display that did not stop cleanly would make Xvnc
    // refuse to listen.
    fs.rmSync(socketPath, { force: true })
    for (const [file, data] of [
      [xauthFile, xauth],
      ...(tools.windowManager
        ? ([
            [wmMenu, OPENBOX_MENU],
            [wmConfig, openboxConfig(wmMenu)],
          ] as const)
        : []),
    ] as const) {
      fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
    }
  }
  const { width, height } = displayGeometry()
  const env = buildChildEnv({})

  const xvnc = track(
    entry,
    spawnAgentProcess({
      kind: 'browser',
      command: tools.xvnc,
      args: [
        '-displayfd',
        '1',
        '-auth',
        xauthFile,
        '-rfbunixpath',
        socketPath,
        '-rfbunixmode',
        '0600',
        '-rfbport',
        '-1',
        '-SecurityTypes',
        'None',
        '-nolisten',
        'tcp',
        '-geometry',
        `${width}x${height}`,
        '-depth',
        '24',
        // What the agent copies stays on its display: nobody watching is sent it.
        '-SendCutText=0',
        '-AlwaysShared',
        '-desktop',
        'Clawboo agent',
      ],
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }),
  )
  markDesktopToolsInUse(tools.xvnc, xvnc.pid)
  const display = await readDisplayNumber(xvnc, START_TIMEOUT_MS)
  const rfb = await connectRfb(entry, socketPath)

  const displayEnv: Record<string, string> = {
    DISPLAY: `:${display}`,
    XAUTHORITY: xauthFile,
  }
  let busAddress: string | null = null
  if (tools.dbusDaemon) {
    // A private session bus for this display, so accessibility (AT-SPI) has a
    // bus to live on and nothing reaches for the server user's own.
    busAddress = `unix:path=${path.join(dir, 'bus')}`
    track(
      entry,
      spawnAgentProcess({
        kind: 'browser',
        command: tools.dbusDaemon,
        args: ['--session', '--nofork', '--nopidfile', `--address=${busAddress}`],
        env: displayServiceEnv(env, displayEnv, dir),
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      }),
    )
    displayEnv['DBUS_SESSION_BUS_ADDRESS'] = busAddress
  } else {
    // No bus, said outright: unset, a program here would look for the person's.
    displayEnv['DBUS_SESSION_BUS_ADDRESS'] = NO_SESSION_BUS
    displayEnv['NO_AT_BRIDGE'] = '1'
  }
  if (tools.windowManager) {
    track(
      entry,
      spawnAgentProcess({
        kind: 'browser',
        command: tools.windowManager.bin,
        // `--sm-disable`: it never joins a desktop session's session manager,
        // which could restart it, or bring it back at the next login.
        args: ['--config-file', wmConfig, '--sm-disable'],
        env: displayServiceEnv(env, displayEnv, dir),
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
      }),
    )
  }

  const agentDisplay: AgentDisplay = {
    agentId,
    display,
    dir,
    xauthFile,
    socketPath,
    busAddress,
    width: rfb.width,
    height: rfb.height,
    rfb,
    env: displayEnv,
  }
  // Its size as the display last said it, whether or not anyone watches.
  rfb.on('resize', (width: number, height: number) => {
    agentDisplay.width = width
    agentDisplay.height = height
  })
  // The display going away on its own (Xvnc crashed, or the relay died) ends it
  // for everyone. Its holders hear it (onDisplayChange): the agent's browser is
  // closed, and starts on a new display at its next use.
  rfb.once('close', () => {
    if (entry.display !== agentDisplay) return
    entry.display = null
    stopProcs(entry)
    events.emit('change', agentId, null)
  })
  xvnc.once('close', () => rfb.close())
  return agentDisplay
}

/** Stop the display that has been without a holder longest, if any. */
function stopOldestUnheld(except: string): void {
  for (const [id, e] of entries) {
    if (id !== except && e.holders.size === 0 && e.display) {
      stopDisplayNow(id)
      return
    }
  }
}

function runningCount(): number {
  let n = 0
  for (const e of entries.values()) if (e.display || e.starting) n += 1
  return n
}

/**
 * Hold this agent's display, starting it if it is not running. Resolves to null
 * when agents get no display here (not Linux, no Xvnc, turned off, or every
 * display slot taken); the caller then goes on without one.
 */
export async function acquireDisplay(
  agentId: string,
  holder: string,
): Promise<AgentDisplay | null> {
  const support = displaySupport()
  if (!support.ok) return null
  let entry = entries.get(agentId)
  if (!entry) {
    entry = { display: null, starting: null, holders: new Set(), stopTimer: null, procs: [] }
    entries.set(agentId, entry)
  }
  entry.holders.add(holder)
  if (entry.stopTimer) {
    clearTimeout(entry.stopTimer)
    entry.stopTimer = null
  }
  if (entry.display && !entry.display.rfb.isClosed) return entry.display
  if (entry.starting) {
    // Joined a start already under way: if it fails, this holder holds nothing,
    // or it would keep a display it never had from ever stopping.
    const d = await entry.starting
    if (!d) entry.holders.delete(holder)
    return d
  }
  // A display only waiting out its stop grace gives up its place first.
  if (runningCount() >= MAX_DISPLAYS) stopOldestUnheld(agentId)
  if (runningCount() >= MAX_DISPLAYS) {
    log.warn({ agentId, max: MAX_DISPLAYS }, 'every display slot is taken; going on without one')
    entry.holders.delete(holder)
    return null
  }
  const e = entry
  e.starting = startDisplay(agentId, e, support.tools)
    .then((d) => {
      // Stopped while it was starting (its agent was deleted, say): the entry
      // is gone, so nothing would ever stop what started. Stop it now.
      if (entries.get(agentId) !== e) {
        d.rfb.close()
        stopProcs(e)
        return null
      }
      e.display = d
      lastProblem = null
      log.info(
        { agentId, display: d.display, wm: support.tools.windowManager?.bin ?? null },
        'started a display for an agent',
      )
      events.emit('change', agentId, d)
      return d
    })
    .catch((err: unknown) => {
      stopProcs(e)
      e.holders.delete(holder)
      lastProblem = describeStartFailure(
        err instanceof Error ? err.message : String(err),
        support.tools.xvnc === ownedXvnc(),
      )
      log.warn(
        { agentId, err: err instanceof Error ? err.message : String(err) },
        'could not start a display for an agent',
      )
      return null
    })
    .finally(() => {
      e.starting = null
    })
  return e.starting
}

/** Let go of this agent's display; it stops once nothing holds it. */
export function releaseDisplay(agentId: string, holder: string): void {
  const entry = entries.get(agentId)
  if (!entry) return
  entry.holders.delete(holder)
  if (entry.holders.size > 0 || entry.stopTimer) return
  entry.stopTimer = setTimeout(() => {
    entry.stopTimer = null
    if (entry.holders.size > 0) return
    stopDisplayNow(agentId)
  }, STOP_GRACE_MS)
  entry.stopTimer.unref()
}

/** Stop this agent's display now, whoever holds it. */
export function stopDisplayNow(agentId: string): void {
  const entry = entries.get(agentId)
  if (!entry) return
  entries.delete(agentId)
  if (entry.stopTimer) clearTimeout(entry.stopTimer)
  const was = entry.display
  entry.display = null
  was?.rfb.close()
  stopProcs(entry)
  if (was) events.emit('change', agentId, null)
}

/** Stop every display. The shutdown path, and the test reset. */
export function stopAllDisplays(): void {
  for (const agentId of [...entries.keys()]) stopDisplayNow(agentId)
}

/** For status: which agents hold a display, and who holds each. */
export function displayHolders(agentId: string): string[] {
  return [...(entries.get(agentId)?.holders ?? [])]
}
