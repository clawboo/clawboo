// The durable runtime pid record exists for the case the in-memory registry
// cannot cover: an engine that dies without running its shutdown. These pin the
// record itself, the identity checks the boot reap applies before it signals
// anything, and the reap.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  currentBootAt,
  currentInitStart,
  currentPidNamespace,
  type StartTimes,
} from '../../processIdentity'
import { killProcessTreeByPid } from '../killTree'
import {
  __resetRuntimePidRecordForTests,
  reapOrphanedRuntimeChildren,
  recordRuntimePid,
  runtimePidDir,
  startRuntimePidRecord,
  type RuntimeReapDeps,
  type RuntimeReapReport,
} from '../runtimePidFile'
import { createSpawnDriver } from '../subprocess'

const isWin = process.platform === 'win32'

/** Above every platform's default pid_max, so it cannot be live. */
const DEAD_PID = 4_194_304

interface RecordFileShape {
  owner: {
    pid: number
    startedAt: number
    bootAt: number
    pidNamespace?: string | null
    initStart?: number | null
  }
  children: { pid: number; startedAt: number; command?: string }[]
}

let home: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
const sleepers: ChildProcess[] = []

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-runtime-pids-'))
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = home
  __resetRuntimePidRecordForTests()
})

afterEach(() => {
  __resetRuntimePidRecordForTests()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  rmSync(home, { recursive: true, force: true })
  for (const child of sleepers.splice(0)) {
    if (child.pid && alive(child.pid)) killProcessTreeByPid(child.pid)
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A real process that just started: a live pid for the identity checks to probe. */
function spawnSleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
  sleepers.push(child)
  if (!child.pid) throw new Error('no pid')
  return child.pid
}

/** A record file as another engine would have left it. */
function writeEngineFile(name: string, record: unknown): string {
  mkdirSync(runtimePidDir(), { recursive: true })
  const file = path.join(runtimePidDir(), name)
  writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record), 'utf8')
  return file
}

/** An engine that is gone: its pid is free. */
const goneEngine = () => ({
  pid: DEAD_PID,
  startedAt: Date.now() - 60 * 60_000,
  bootAt: currentBootAt(),
  pidNamespace: currentPidNamespace(),
  initStart: currentInitStart(),
})

function ownFiles(): string[] {
  return existsSync(runtimePidDir()) ? readdirSync(runtimePidDir()) : []
}

function readOwn(): RecordFileShape {
  const [name] = ownFiles()
  if (!name) throw new Error('no record file')
  return JSON.parse(readFileSync(path.join(runtimePidDir(), name), 'utf8')) as RecordFileShape
}

describe('runtime pid record', () => {
  it('writes nothing until this engine starts recording', () => {
    // Boot order: the reap runs first and must only ever see OTHER engines'
    // files. It also keeps suites that spawn real children out of ~/.clawboo.
    recordRuntimePid(111, 'codex')()
    expect(ownFiles()).toEqual([])
  })

  it('records children in a file of its own, owned by this engine, and forgets them', () => {
    startRuntimePidRecord()
    const forgetCodex = recordRuntimePid(111, 'codex')
    const forgetHermes = recordRuntimePid(222, 'hermes')

    const record = readOwn()
    expect(record.owner.pid).toBe(process.pid)
    expect(record.owner.bootAt).toBe(currentBootAt())
    expect(record.owner.pidNamespace).toBe(currentPidNamespace())
    expect(record.children.map((c) => [c.pid, c.command])).toEqual([
      [111, 'codex'],
      [222, 'hermes'],
    ])

    forgetCodex()
    expect(readOwn().children.map((c) => c.pid)).toEqual([222])
    // The last child gone, the file goes too: a clean shutdown leaves no trace.
    forgetHermes()
    expect(ownFiles()).toEqual([])
  })

  it('a stale forget does not drop a newer record for the same pid', () => {
    // A pid freed by one child and reissued to the next must keep the newer record.
    startRuntimePidRecord()
    const forgetOld = recordRuntimePid(111)
    const forgetNew = recordRuntimePid(111)
    forgetOld()
    expect(readOwn().children.map((c) => c.pid)).toEqual([111])
    forgetNew()
    expect(ownFiles()).toEqual([])
  })

  it('ignores a spawn that produced no pid', () => {
    startRuntimePidRecord()
    recordRuntimePid(undefined)
    recordRuntimePid(0)
    expect(ownFiles()).toEqual([])
  })
})

/** On Windows the real probe is a PowerShell start, which on a loaded runner can take
 *  past a test's timeout. There these tests stand in what it would say of a process that
 *  has just started. It has its own test below, given the time it can need. */
const startedJustNow = (pids: readonly number[]): StartTimes => ({
  ok: true,
  times: new Map(pids.map((pid) => [pid, Date.now()])),
})
const reap = (deps: RuntimeReapDeps = {}): RuntimeReapReport =>
  reapOrphanedRuntimeChildren({ ...(isWin ? { startTimes: startedJustNow } : {}), ...deps })

describe('boot reap of runtime children', () => {
  it('kills a live child of an engine that is gone and drops the file', () => {
    const child = spawnSleeper()
    const file = writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [{ pid: child, startedAt: Date.now(), command: 'node' }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([child])
    expect(report.killed).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  it('NEVER signals a recorded pid that now belongs to an unrelated process', () => {
    // The hazard the identity check exists for. The record says its child
    // started ten minutes ago; the process holding that number now started just
    // this moment, so it is somebody else's, and liveness alone cannot tell.
    const stranger = spawnSleeper()
    writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [{ pid: stranger, startedAt: Date.now() - 10 * 60_000 }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
    expect(alive(stranger)).toBe(true)
  })

  it('does not signal a pid whose process started half a minute after the record', () => {
    // A record is written as soon as the spawn returns, so a process that took
    // the pid even seconds later is not the child: killing it would take a
    // stranger's whole process tree.
    const stranger = spawnSleeper()
    writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [{ pid: stranger, startedAt: Date.now() - 30_000 }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
    expect(alive(stranger)).toBe(true)
  })

  it('leaves a file from another PID namespace alone', () => {
    // Another container sharing the state directory: its pids name processes in
    // its own namespace, so the same number here is somebody else, and its
    // engine may be running where this process cannot see it.
    const child = spawnSleeper()
    const file = writeEngineFile('elsewhere.json', {
      owner: { ...goneEngine(), pidNamespace: 'pid:[222]' },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({
      kill: (pid) => killed.push(pid),
      pidNamespace: 'pid:[111]',
    })
    expect(killed).toEqual([])
    expect(report.foreign).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it('leaves a file that does not say which PID namespace wrote it', () => {
    const child = spawnSleeper()
    const { pidNamespace: _, ...owner } = goneEngine()
    const file = writeEngineFile('unmarked.json', {
      owner,
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(report.foreign).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it('reaps a file from its own PID namespace', () => {
    const child = spawnSleeper()
    writeEngineFile('here.json', {
      owner: { ...goneEngine(), pidNamespace: 'pid:[111]', initStart: 4_000 },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    reap({
      kill: (pid) => killed.push(pid),
      pidNamespace: 'pid:[111]',
      initStart: 4_000,
      platform: 'linux',
    })
    expect(killed).toEqual([child])
  })

  it("records when its PID namespace's pid 1 started", () => {
    startRuntimePidRecord()
    recordRuntimePid(111, 'codex')
    expect(readOwn().owner).toHaveProperty('initStart', currentInitStart())
  })

  it('drops, unsignalled, the file of an earlier run of its own PID namespace', () => {
    // A restarted container can come back with the namespace id its previous
    // run had, under the same host boot. Every process of that run died with
    // its pid 1, so the numbers in the file now belong to somebody else.
    const stranger = spawnSleeper()
    const file = writeEngineFile('before-restart.json', {
      owner: { ...goneEngine(), pidNamespace: 'pid:[111]', initStart: 3_000 },
      children: [{ pid: stranger, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({
      kill: (pid) => killed.push(pid),
      pidNamespace: 'pid:[111]',
      initStart: 4_000,
      platform: 'linux',
    })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  it("leaves a Linux file that does not say when its namespace's pid 1 started", () => {
    // Written before that was recorded: it may be an earlier run of this
    // namespace, or a live engine of this one, and nothing in it tells which.
    const child = spawnSleeper()
    const { initStart: _, ...owner } = goneEngine()
    const file = writeEngineFile('older.json', {
      owner: { ...owner, pidNamespace: 'pid:[111]' },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({
      kill: (pid) => killed.push(pid),
      pidNamespace: 'pid:[111]',
      initStart: 4_000,
      platform: 'linux',
    })
    expect(killed).toEqual([])
    expect(report.foreign).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it("leaves every file alone on Linux when it cannot read its own pid 1's start", () => {
    // Under `hidepid` both sides read as null, and two nulls would match.
    const child = spawnSleeper()
    const file = writeEngineFile('unreadable.json', {
      owner: { ...goneEngine(), pidNamespace: 'pid:[111]', initStart: null },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({
      kill: (pid) => killed.push(pid),
      pidNamespace: 'pid:[111]',
      initStart: null,
      platform: 'linux',
    })
    expect(killed).toEqual([])
    expect(report.foreign).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it('leaves the runs of an engine that is still running', () => {
    // Two engines can share a state dir. A live sleeper stands in for the other
    // engine, recorded with the start time it really has.
    const engine = spawnSleeper()
    const child = spawnSleeper()
    const file = writeEngineFile('live.json', {
      owner: {
        pid: engine,
        startedAt: Date.now(),
        bootAt: currentBootAt(),
        pidNamespace: currentPidNamespace(),
        initStart: currentInitStart(),
      },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(report.liveEngines).toBe(1)
    expect(existsSync(file)).toBe(true)
  })

  it('treats an engine pid now held by a different process as gone', () => {
    // The engine's pid is alive, but the process holding it started long after
    // the engine did: the engine is gone, so its children are orphans.
    const stranger = spawnSleeper()
    const child = spawnSleeper()
    writeEngineFile('recycled.json', {
      owner: {
        pid: stranger,
        startedAt: Date.now() - 2 * 60 * 60_000,
        bootAt: currentBootAt(),
        pidNamespace: currentPidNamespace(),
        initStart: currentInitStart(),
      },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([child])
  })

  it("treats a file naming this process as its owner as a previous engine's", () => {
    // A container restart can hand the new engine its predecessor's pid.
    const child = spawnSleeper()
    writeEngineFile('same-pid.json', {
      owner: {
        pid: process.pid,
        startedAt: Date.now() - 60 * 60_000,
        bootAt: currentBootAt(),
        pidNamespace: currentPidNamespace(),
        initStart: currentInitStart(),
      },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([child])
  })

  it('drops records from a different boot without signalling', () => {
    const child = spawnSleeper()
    const file = writeEngineFile('old-boot.json', {
      owner: { ...goneEngine(), bootAt: 1 },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  it('expires a record older than the trust window without signalling', () => {
    const child = spawnSleeper()
    writeEngineFile('old.json', {
      owner: goneEngine(),
      children: [{ pid: child, startedAt: Date.now() - 13 * 60 * 60_000 }],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(report.expired).toBe(1)
  })

  it('fails closed when this host cannot report process start times', () => {
    // Boot time, age and liveness all pass, but nothing can show the pid is
    // still ours. A runtime reap is a whole-tree kill, so it is left alone.
    const child = spawnSleeper()
    writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({
      kill: (pid) => killed.push(pid),
      startTimes: () => ({ ok: false, times: new Map() }),
    })
    expect(killed).toEqual([])
    expect(report.unverified).toBe(1)
  })

  it('keeps the file when it could not check, so a later start that can check kills the child', () => {
    // A slow probe must not cost the only record of an agent still running.
    const child = spawnSleeper()
    const file = writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [
        { pid: child, startedAt: Date.now() },
        { pid: DEAD_PID, startedAt: Date.now() },
      ],
    })
    const killed: number[] = []
    reap({
      kill: (pid) => killed.push(pid),
      startTimes: () => ({ ok: false, times: new Map(), error: 'timed out' }),
    })
    expect(killed).toEqual([])
    expect(existsSync(file)).toBe(true)

    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([child])
    expect(report.killed).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  it(
    'kills a live child by the real probe, however long it takes to answer',
    { timeout: 120_000 },
    () => {
      const child = spawnSleeper()
      writeEngineFile('gone.json', {
        owner: goneEngine(),
        children: [{ pid: child, startedAt: Date.now() }],
      })
      const killed: number[] = []
      reapOrphanedRuntimeChildren({ kill: (pid) => killed.push(pid) })
      expect(killed).toEqual([child])
    },
  )

  it('assumes a held engine pid is the engine when start times are unavailable', () => {
    const engine = spawnSleeper()
    const child = spawnSleeper()
    writeEngineFile('unknown.json', {
      owner: {
        pid: engine,
        startedAt: Date.now() - 2 * 60 * 60_000,
        bootAt: currentBootAt(),
        pidNamespace: currentPidNamespace(),
        initStart: currentInitStart(),
      },
      children: [{ pid: child, startedAt: Date.now() }],
    })
    const killed: number[] = []
    const report = reap({
      kill: (pid) => killed.push(pid),
      startTimes: () => ({ ok: false, times: new Map() }),
    })
    expect(killed).toEqual([])
    expect(report.liveEngines).toBe(1)
  })

  it('never signals this process or its parent, whatever a record says', () => {
    writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [
        { pid: process.pid, startedAt: Date.now() },
        { pid: process.ppid, startedAt: Date.now() },
      ],
    })
    const killed: number[] = []
    reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
  })

  it('one dead child does not cost a live one its corroboration', () => {
    // The probe is batched, and `ps -p` prints NOTHING when any id is invalid.
    const child = spawnSleeper()
    writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [
        { pid: DEAD_PID, startedAt: Date.now() },
        { pid: child, startedAt: Date.now() },
      ],
    })
    const killed: number[] = []
    const report = reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([child])
    expect(report.unverified).toBe(0)
  })

  it("never touches this engine's own file", () => {
    startRuntimePidRecord()
    const child = spawnSleeper()
    recordRuntimePid(child, 'node')
    const killed: number[] = []
    reap({ kill: (pid) => killed.push(pid) })
    expect(killed).toEqual([])
    expect(readOwn().children.map((c) => c.pid)).toEqual([child])
  })

  it('discards an unreadable file rather than throwing', () => {
    const file = writeEngineFile('corrupt.json', '{not json')
    expect(() => reap({ kill: () => {} })).not.toThrow()
    expect(existsSync(file)).toBe(false)
  })

  it.skipIf(isWin)('kills the orphaned child with its descendants by default', async () => {
    // The real killer: a recorded child that has a child of its own. Both must
    // die, or a shell tool's subprocess would go on running after its agent.
    const PARENT_SCRIPT = [
      'const cp = require("child_" + "process")',
      'const c = cp.spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" })',
      'process.stdout.write("GPID " + c.pid + "\\n")',
      'setInterval(() => {}, 1e9)',
    ].join('\n')
    const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    sleepers.push(parent)
    const gpid = await new Promise<number>((resolve, reject) => {
      let buf = ''
      parent.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        const m = buf.match(/GPID (\d+)/)
        if (m) resolve(Number(m[1]))
      })
      parent.once('error', reject)
    })
    writeEngineFile('gone.json', {
      owner: goneEngine(),
      children: [{ pid: parent.pid, startedAt: Date.now() }],
    })

    const report = reapOrphanedRuntimeChildren()
    expect(report.killed).toBe(1)

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && (alive(parent.pid!) || alive(gpid))) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(alive(parent.pid!)).toBe(false)
    expect(alive(gpid)).toBe(false)
  })
})

describe('recording runtime children as they spawn', () => {
  it('a runtime CLI is recorded while it runs and forgotten when it closes', async () => {
    startRuntimePidRecord()
    const driver = createSpawnDriver<{ type: 'done' }>({
      resolve: async () => ({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 300)'],
      }),
      parseLine: () => [],
      onClose: () => [{ type: 'done' }],
    })
    const done = new Promise<void>((resolve) => driver.onEvent(() => resolve()))
    await driver.start()

    const record = readOwn()
    expect(record.children).toHaveLength(1)
    expect(record.children[0]!.command).toBe(path.basename(process.execPath))

    await done
    expect(ownFiles()).toEqual([])
  })
})
