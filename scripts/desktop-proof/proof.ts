// A desktop per agent, proven end to end inside a Linux container. Bundled by
// run.sh and run in the container as the server user (`clawboo`, uid 10001).
//
//   node proof.cjs plain   agents run as the server's own user
//   node proof.cjs agent   agents run as `clawboo-agent` (uid 10002) through
//                          the agent host (CLAWBOO_AGENT_USER, sudo)
//
// For each: the agent gets a display of its own (a real Xvnc) with a window
// manager; its browser (a stand-in connector that opens real Chromium) starts
// on that display, as the agent's user; the live view sends pictures of it;
// a person takes over and types into a window on it; a view link cannot; and
// stopping leaves nothing running. Prints PASS or FAIL per check and writes
// what the live view saw to /out/screen-<mode>.png. Exit code: failures.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { agentReadFile } from '../../apps/web/server/lib/agentUser/agentFs'
import { startAgentUser } from '../../apps/web/server/lib/agentUser/boot'
import { agentHomeDir } from '../../apps/web/server/lib/agentUser/state'
import {
  agentBrowserSession,
  closeAllAgentBrowsers,
} from '../../apps/web/server/lib/connectors/agentBrowsers'
import { isPersonInControl } from '../../apps/web/server/lib/desktop/control'
import {
  acquireDisplay,
  displayFor,
  displayProblem,
  displaySupport,
  releaseDisplay,
  setDisplayBinaryLookupForTests,
  stopAllDisplays,
} from '../../apps/web/server/lib/desktop/displays'
import { installDesktopTools, ownedXvnc } from '../../apps/web/server/lib/desktop/tools'
import { findExecutable } from '../../apps/web/server/lib/platform'
import { readRuntimeInstall } from '../../apps/web/server/lib/runtimeFolder'
import { mintLink } from '../../apps/web/server/lib/desktop/links'
import { openViewer, sendInput, setControl } from '../../apps/web/server/lib/desktop/liveView'
import { encodeRegionPng } from '../../apps/web/server/lib/desktop/png'
import { connectorPlaceRefusal, toConnectable } from '../../apps/web/server/api/connectors'
import {
  connectConnector,
  resetConnectorsForTests,
} from '../../apps/web/server/lib/connectors/supervisor'
import { connectorBySlug } from '@clawboo/connector-catalog'
import { createDb } from '@clawboo/db'
import { buildChildEnv } from '../../apps/web/server/lib/runtimes/childEnv'
import { spawnAgentProcess } from '../../apps/web/server/lib/runtimes/spawner'

const mode =
  process.argv[2] === 'agent' ? 'agent' : process.argv[2] === 'install' ? 'install' : 'plain'
const AGENT_UID = mode === 'agent' ? 10002 : 10001
let failures = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  [${mode}] ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}\n`,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const log = {
  info: () => undefined,
  warn: (o: unknown, m?: string) => process.stdout.write(`warn  ${m ?? JSON.stringify(o)}\n`),
  error: (o: unknown, m?: string) => process.stdout.write(`error ${m ?? JSON.stringify(o)}\n`),
}

/** Every process's full command line. */
function commandLines(): string[] {
  const r = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** A tool result's text, whichever shape it came back in. */
function textOf(r: unknown): string {
  if (typeof r === 'string') return r
  const t = (r as { text?: unknown } | null)?.text
  return typeof t === 'string' ? t : JSON.stringify(r)
}

/** Every process of a user, by command, zombies left out. */
function processesOf(uid: number): string[] {
  const r = spawnSync('ps', ['-u', String(uid), '-o', 'stat=,comm='], { encoding: 'utf8' })
  return (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('Z'))
    .map((s) => s.split(/\s+/)[1] ?? '')
}

/** Read back a PNG the live view sent (RGB, Sub filter, as png.ts writes it). */
function decodePng(png: Buffer): { w: number; h: number; rgb: Buffer } {
  let off = 8
  let w = 0
  let h = 0
  const idat: Buffer[] = []
  for (;;) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    off += 12 + len
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const rgb = Buffer.alloc(w * h * 3)
  for (let row = 0; row < h; row++) {
    const line = raw.subarray(row * (w * 3 + 1) + 1, (row + 1) * (w * 3 + 1))
    for (let i = 0; i < w * 3; i++) {
      const left = i >= 3 ? rgb[row * w * 3 + i - 3]! : 0
      rgb[row * w * 3 + i] = (line[i]! + left) & 0xff
    }
  }
  return { w, h, rgb }
}

/**
 * The desktop tools install, against the real releases: downloaded, checked
 * against the pinned SHA-256s, unpacked into the runtimes folder and made
 * current. On x86_64 a display is then started from Clawboo's own Xvnc (the
 * system's is set aside), and the installed Cua Driver runs.
 */
async function installProof(): Promise<void> {
  const done = await installDesktopTools()
  const record = readRuntimeInstall('desktop')
  check('the pinned desktop tools install and become current', record !== null, done)
  check(
    'Cua Driver is installed',
    !!done.cuaDriver && record?.launchers['cua-driver']?.command === done.cuaDriver,
    record,
  )
  const version = spawnSync(done.cuaDriver ?? '/nonexistent', ['--version'], { encoding: 'utf8' })
  check('the installed Cua Driver runs', /0\.38\.0/.test(version.stdout), version)
  for (const file of [done.cuaDriver, done.tigervnc].filter((f): f is string => !!f)) {
    const st = fs.statSync(file)
    check(
      `${path.basename(file)} is the server user's and nobody else can change it`,
      st.uid === 10001 && (st.mode & 0o022) === 0,
      { uid: st.uid, mode: (st.mode & 0o777).toString(8) },
    )
  }
  if (process.arch !== 'x64') {
    check('TigerVNC is not installed where it publishes no build', done.tigervnc === null, done)
    return
  }
  check('Xvnc is installed', !!done.tigervnc, done)
  // The system's Xvnc would be used first; set it aside to prove Clawboo's own.
  setDisplayBinaryLookupForTests((name) => (name === 'Xvnc' ? ownedXvnc() : findExecutable(name)))
  const support = displaySupport()
  check(
    "agents' displays use Clawboo's own Xvnc",
    support.ok && support.tools.xvnc === done.tigervnc,
    support,
  )
  const display = await acquireDisplay('agent-1', 'proof')
  check("Clawboo's own Xvnc starts an agent display", display !== null, displayProblem())
  if (display) {
    const xdpy = spawnSync('xdpyinfo', ['-display', `:${display.display}`], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', XAUTHORITY: display.xauthFile },
    })
    check('a program with the cookie opens that display', xdpy.status === 0, xdpy.stderr)
  }
  stopAllDisplays()
}

async function main(): Promise<void> {
  if (mode === 'install') return installProof()
  if (mode === 'agent') {
    const report = await startAgentUser({
      log,
      accessToken: process.env['STUDIO_ACCESS_TOKEN'] ?? null,
      secretValues: [process.env['STUDIO_ACCESS_TOKEN'] ?? ''].filter(Boolean),
      runtimeBinaries: [{ runtime: 'node', path: process.execPath }],
    })
    check(
      'the agent host is running',
      !report.steps.some((s) => s.level === 'fail'),
      report.steps.filter((s) => s.level === 'fail'),
    )
  }

  const support = displaySupport()
  check('agents get displays here (Linux, Xvnc found)', support.ok, support)
  if (!support.ok) return
  check('a window manager was found', support.tools.windowManager !== null, support.tools)

  // ── The display ──────────────────────────────────────────────────────────
  const display = await acquireDisplay('agent-1', 'proof')
  check('the agent gets a display', display !== null)
  if (!display) return
  const other = await acquireDisplay('agent-2', 'proof')
  check(
    'another agent gets a different display, folder and cookie',
    other !== null &&
      other.display !== display.display &&
      other.dir !== display.dir &&
      other.xauthFile !== display.xauthFile,
    { a: display.display, b: other?.display },
  )
  await sleep(1500)
  const procs = processesOf(AGENT_UID)
  // Debian and Ubuntu name TigerVNC's server Xtigervnc; its own build, Xvnc.
  check(
    `Xvnc runs as uid ${AGENT_UID}`,
    procs.includes('Xvnc') || procs.includes('Xtigervnc'),
    procs,
  )
  check(`the window manager runs as uid ${AGENT_UID}`, procs.includes('openbox'), procs)

  const xvncArgs = spawnSync('ps', ['-C', 'Xvnc,Xtigervnc', '-o', 'args='], {
    encoding: 'utf8',
  }).stdout
  check(
    'Xvnc listens on no TCP port',
    /-rfbport -1/.test(xvncArgs) && /-nolisten tcp/.test(xvncArgs),
    xvncArgs,
  )
  const listening =
    fs.readFileSync('/proc/net/tcp', 'utf8') + fs.readFileSync('/proc/net/tcp6', 'utf8')
  const vncPorts = listening
    .split('\n')
    .filter((l) => / 0A /.test(l))
    .map((l) => parseInt(l.trim().split(/\s+/)[1]!.split(':')[1]!, 16))
    .filter((p) => (p >= 5900 && p < 6000) || (p >= 6000 && p < 6100))
  check('nothing listens on a VNC or X11 TCP port', vncPorts.length === 0, vncPorts)

  if (mode === 'agent') {
    // The server's own user is "anyone else" to the agent user.
    const canEnter = (() => {
      try {
        fs.readdirSync(display.dir)
        return true
      } catch {
        return false
      }
    })()
    check('the server user cannot enter the display folder', !canEnter)
    const connectErr = await new Promise<string | null>((resolve) => {
      const s = net.connect(display.socketPath)
      s.once('connect', () => {
        s.destroy()
        resolve(null)
      })
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
    })
    check('the server user cannot open the VNC socket itself', connectErr !== null, connectErr)
    const xdpy = spawnSync('xdpyinfo', ['-display', `:${display.display}`], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: os.homedir() },
    })
    check(
      'another user cannot open the X display without the cookie',
      xdpy.status !== 0,
      xdpy.stderr,
    )
  }
  // ── The agent's browser, on its display ─────────────────────────────────
  const session = await agentBrowserSession(
    {
      slug: 'proofbrowser',
      command: process.execPath,
      args: ['/proof/fake-browser-mcp.mjs'],
      profileFlag: '--user-data-dir',
    },
    'proof-conn',
    'agent-1',
    { create: true },
  )
  check('the agent browser connector starts', session !== null)
  const opened = await session!.callTool('browser_open', {})
  const seen = JSON.parse(opened.text) as {
    uid: number
    display: string | null
    xauthority: string | null
  }
  check(`the browser runs as uid ${AGENT_UID}`, seen.uid === AGENT_UID, seen)
  check('the browser opens on the agent display', seen.display === `:${display.display}`, seen)
  check('the browser has the display cookie', seen.xauthority === display.xauthFile, seen)

  // ── The live view ────────────────────────────────────────────────────────
  const W = display.width
  const H = display.height
  const screen = Buffer.alloc(W * H * 4)
  let pictures = 0
  let ended = false
  const sink = {
    send(event: string, data: unknown) {
      if (event === 'rects') {
        for (const r of (data as { rects: { x: number; y: number; png: string }[] }).rects) {
          const pic = decodePng(Buffer.from(r.png, 'base64'))
          for (let row = 0; row < pic.h; row++) {
            for (let col = 0; col < pic.w; col++) {
              const o = ((r.y + row) * W + r.x + col) * 4
              const i = (row * pic.w + col) * 3
              screen[o] = pic.rgb[i]!
              screen[o + 1] = pic.rgb[i + 1]!
              screen[o + 2] = pic.rgb[i + 2]!
            }
          }
          pictures += 1
        }
      }
      if (event === 'end') ended = true
      return true
    },
    onDrain() {},
    end() {
      ended = true
    },
  }
  const viewer = openViewer('agent-1', { kind: 'dashboard' }, sink)
  let green = 0
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    green = 0
    for (let p = 0; p < W * H; p++) {
      const r = screen[p * 4]!
      const g = screen[p * 4 + 1]!
      const b = screen[p * 4 + 2]!
      if (r < 60 && g > 200 && b > 70 && b < 140) green += 1
    }
    if (green > W * H * 0.3) break
  }
  fs.mkdirSync('/out', { recursive: true })
  fs.writeFileSync(`/out/screen-${mode}.png`, encodeRegionPng(screen, W, 0, 0, W, H))
  check('the live view sends pictures of the display', pictures > 0, pictures)
  check('the live view shows the agent browser page', green > W * H * 0.3, {
    greenShare: green / (W * H),
  })

  // ── Take over ────────────────────────────────────────────────────────────
  const home = mode === 'agent' ? agentHomeDir() : os.homedir()
  const typed = path.join(home, 'typed.txt')
  const xterm = spawnAgentProcess({
    kind: 'tool',
    command: '/usr/bin/xterm',
    args: [
      '-geometry',
      '40x6+300+200',
      '-e',
      '/bin/sh',
      '-c',
      `read l; printf %s "$l" > ${JSON.stringify(typed)}`,
    ],
    env: buildChildEnv(display.env),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  xterm.on('error', () => undefined)
  await sleep(2500)

  const before = sendInput('agent-1', viewer.viewerId, { kind: 'dashboard' }, [
    { t: 'k', s: 0x78, d: true },
  ])
  check('no input reaches the display before taking over', !before.ok, before)

  const viewLink = mintLink('agent-1', 'view').link
  const viewVia = { kind: 'link' as const, linkId: viewLink.id, linkKind: 'view' as const }
  const watcher = openViewer('agent-1', viewVia, { send: () => true, onDrain() {}, end() {} })
  const refused = setControl('agent-1', watcher.viewerId, viewVia, 'take')
  check('a view link cannot take over', !refused.ok, refused)

  const took = setControl('agent-1', viewer.viewerId, { kind: 'dashboard' }, 'take')
  check('a person takes over', took.ok && isPersonInControl('agent-1'), took)
  const keys = (text: string) =>
    [...text].flatMap((c) => [
      { t: 'k' as const, s: c.charCodeAt(0), d: true },
      { t: 'k' as const, s: c.charCodeAt(0), d: false },
    ])
  sendInput('agent-1', viewer.viewerId, { kind: 'dashboard' }, [
    { t: 'p', x: 400, y: 260, b: 0 },
    { t: 'p', x: 400, y: 260, b: 1 },
    { t: 'p', x: 400, y: 260, b: 0 },
  ])
  await sleep(500)
  const sent = sendInput('agent-1', viewer.viewerId, { kind: 'dashboard' }, [
    ...keys('hello'),
    { t: 'k', s: 0xff0d, d: true },
    { t: 'k', s: 0xff0d, d: false },
  ])
  check('the person in control sends keys', sent.ok, sent)
  let got: string | null = null
  for (let i = 0; i < 20 && got === null; i++) {
    await sleep(500)
    if (mode === 'agent') got = (await agentReadFile(typed).catch(() => null))?.toString() ?? null
    else got = fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8') : null
  }
  check('what the person typed reached a window on the agent display', got === 'hello', got)
  setControl('agent-1', viewer.viewerId, { kind: 'dashboard' }, 'release')
  check('handing back returns control to the agent', !isPersonInControl('agent-1'))

  // ── The desktop driver, through Clawboo's connector path ───────────────────
  const installed = await installDesktopTools()
  check('Cua Driver installs from its pinned release', !!installed.cuaDriver, installed)
  const driverDef = connectorBySlug('cua-driver')!
  // It types into the agent's browser: only where that runs as the agent user.
  const placeRefusal = connectorPlaceRefusal(driverDef)
  if (mode === 'agent') {
    check('the driver can be connected here', placeRefusal === null, placeRefusal)
  } else {
    check(
      'Connect refuses the driver while agents run as the server user',
      placeRefusal?.reason === 'needs-agent-user',
      placeRefusal,
    )
  }
  const launch = driverDef.launch as Extract<typeof driverDef.launch, { transport: 'stdio' }>
  const db = createDb(path.join(os.homedir(), `proof-${mode}.db`))
  // Exactly as the Connect route hands it to the supervisor.
  const { connector } = await connectConnector(db, toConnectable(driverDef, [...launch.args]))
  // The shared child only lists the tools. Its bus is set, and leads nowhere.
  const sharedBus = textOf(await connector.session.callTool('check_permissions', {}))
  check(
    "the driver's shared child is given a bus, which reaches nothing",
    !/DBUS_SESSION_BUS_ADDRESS unset/.test(sharedBus) &&
      !/org\.a11y\.Bus reachable/.test(sharedBus),
    sharedBus.slice(0, 400),
  )
  const listWindows = connector.descriptors.find((d) => d.name.endsWith('__list_windows'))
  check('the driver offers its tools through Clawboo', !!listWindows, connector.descriptors.length)
  if (listWindows && mode !== 'agent') {
    // Connected anyway (as an earlier setting might have), it still starts no
    // driver for an agent.
    const refused = await listWindows.executor({}, { agentId: 'agent-1' } as never).then(
      () => null,
      (err: Error) => err.message,
    )
    // Only the shared child that lists the tools runs, never one for an agent.
    const running = commandLines().filter((c) => /(^|\/)cua-driver\s+mcp\b/.test(c))
    check(
      'no driver starts for an agent while agents run as the server user',
      /CLAWBOO_AGENT_USER/.test(refused ?? '') && running.length === 1,
      { refused, running },
    )
  } else if (listWindows) {
    const mine = String(await listWindows.executor({}, { agentId: 'agent-1' } as never))
    check(
      "agent 1's driver sees agent 1's browser window",
      /chromium|agent display/i.test(mine),
      mine.slice(0, 400),
    )
    const theirs = String(await listWindows.executor({}, { agentId: 'agent-2' } as never))
    check(
      "agent 2's driver does not see agent 1's window",
      !/chromium|agent display/i.test(theirs),
      theirs.slice(0, 400),
    )
    check(
      `the driver runs as uid ${AGENT_UID}`,
      processesOf(AGENT_UID).includes('cua-driver'),
      processesOf(AGENT_UID),
    )
    const drivers = commandLines().filter((c) => /(^|\/)cua-driver\s/.test(c))
    const mcp = drivers.filter((c) => /\smcp\b/.test(c))
    check(
      'every driver runs in its own process, never through a shared Cua Driver service',
      mcp.length >= 3 &&
        mcp.every((c) => /\smcp\s+--direct\b/.test(c)) &&
        !drivers.some((c) => /\sserve\b/.test(c)),
      drivers,
    )
    const agentBus = textOf(
      await connector.descriptors
        .find((d) => d.name.endsWith('__check_permissions'))!
        .executor({}, { agentId: 'agent-1' } as never),
    )
    const ownBus = displayFor('agent-1')?.busAddress ?? null
    check(
      "agent 1's driver is on its display's own bus",
      ownBus !== null &&
        !agentBus.includes('unset') &&
        (!/DBUS_SESSION_BUS_ADDRESS=/.test(agentBus) || agentBus.includes(ownBus)),
      { ownBus, agentBus: agentBus.slice(0, 400) },
    )
    const target = path.join(os.tmpdir(), `proof-driver-write-${mode}.png`)
    const getDesktop = connector.descriptors.find((d) => d.name.endsWith('__get_desktop_state'))!
    const wrote = await getDesktop
      .executor({ screenshot_out_file: target }, { agentId: 'agent-1' } as never)
      .then(
        () => null,
        (err: Error) => err.message,
      )
    check(
      'a read tool may not write a file where it is told',
      /may not write files/.test(wrote ?? '') && !fs.existsSync(target),
      wrote,
    )
    const held = openViewer(
      'agent-1',
      { kind: 'dashboard' },
      { send: () => true, onDrain() {}, end() {} },
    )
    setControl('agent-1', held.viewerId, { kind: 'dashboard' }, 'take')
    const refused = await listWindows.executor({}, { agentId: 'agent-1' } as never).then(
      () => null,
      (err: Error) => err.message,
    )
    check(
      "the driver waits while a person has the agent's screen",
      /person has taken over/.test(refused ?? ''),
      refused,
    )
    setControl('agent-1', held.viewerId, { kind: 'dashboard' }, 'release')
    held.close()
  }
  await resetConnectorsForTests()
  db.$client.close()

  // ── Stop ─────────────────────────────────────────────────────────────────
  viewer.close()
  watcher.close()
  check('the live view stayed open until it was closed', !ended)
  await closeAllAgentBrowsers()
  releaseDisplay('agent-1', 'proof')
  releaseDisplay('agent-2', 'proof')
  stopAllDisplays()
  let left: string[] = []
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    left = processesOf(AGENT_UID).filter((c) =>
      ['Xvnc', 'Xtigervnc', 'openbox', 'chromium', 'xterm', 'dbus-daemon', 'cua-driver'].includes(
        c,
      ),
    )
    if (left.length === 0) break
  }
  check('stopping leaves no display, window manager or browser running', left.length === 0, left)
}

main()
  .catch((err: unknown) => {
    failures++
    process.stdout.write(
      `FAIL  [${mode}] threw: ${err instanceof Error ? err.stack : String(err)}\n`,
    )
  })
  .finally(() => process.exit(failures))
