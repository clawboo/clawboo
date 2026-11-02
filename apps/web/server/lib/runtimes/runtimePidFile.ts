// Durable record of runtime child PIDs, so an engine that dies hard does not
// leave its agent runs working.
//
// The in-memory registry in `subprocess.ts` only helps a GRACEFUL shutdown. A
// crash, a force-quit from the desktop app, or an update restart that kills the
// engine runs no shutdown hook. Runtime children are never `unref`'d and most
// are their own process group, so they keep running with nobody left who knows
// about them. Boot reconciliation then releases their tasks to new runs while
// the old runs go on editing the same worktrees.
//
// Same idiom as the connector record (`connectors/pidFile.ts`) and the same
// identity checks (`../processIdentity`), with two differences:
//
// - ONE FILE PER ENGINE PROCESS, under `runtime-pids/`, rather than one shared
//   file. Two engines can share a state directory (the port scan's fallback, or
//   an update's successor booting while its parent drains), and a booting engine
//   must leave a live engine's runs alone. A file per engine lets the reap ask
//   whether the engine that wrote it is still running, and no engine ever
//   rewrites another's records.
// - FAIL CLOSED. A child is signalled only when the boot matches AND the process
//   holding its pid is shown to have started before our record (within
//   `START_TIME_SLACK_MS`). The connector reap still signals when this host
//   cannot report start times at all; this one does not: a runtime reap is a
//   whole-tree kill of an agent, so a pid that cannot be shown to still be ours
//   is left alone and counted.
//
// BEST EFFORT BY DESIGN: a read-only state directory or a corrupt file degrades
// to "we cannot reap old runs", never to "the server will not start".

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'

import {
  currentBootAt,
  isAlive,
  MAX_TRUSTED_AGE_MS,
  processStartTimes,
  START_TIME_SLACK_MS,
  type StartTimes,
} from '../processIdentity'
import { killProcessTreeByPid } from './killTree'

/** The engine process that wrote a record file. */
interface EngineIdentity {
  pid: number
  /** Epoch ms the engine process started. With `pid`, tells this engine from a
   *  later process that was handed the same number. */
  startedAt: number
  /** See `currentBootAt`. Every child in the file shares it: none can outlive a
   *  reboot. */
  bootAt: number
}

export interface RuntimePidEntry {
  pid: number
  /** Epoch ms, recorded right after the spawn returned, so the child itself
   *  started slightly before it. */
  startedAt: number
  /** The spawned binary's base name, for whoever reads the file. Identity is
   *  decided by boot and start time, never by this. */
  command?: string
}

interface RecordFile {
  owner: EngineIdentity
  children: RuntimePidEntry[]
}

export function runtimePidDir(): string {
  return path.join(resolveClawbooDir(process.env), 'runtime-pids')
}

/** This engine's file, once `startRuntimePidRecord` has run. */
let own: { file: string; owner: EngineIdentity } | null = null
/** This engine's live children. The file is a mirror of this map, rewritten
 *  whole on every change: only this process ever writes it. */
const children = new Map<number, RuntimePidEntry>()

const noop = (): void => {}

/**
 * Start recording this engine's runtime children.
 *
 * Called once at boot, AFTER `reapOrphanedRuntimeChildren`. Until then
 * `recordRuntimePid` does nothing, which keeps the order explicit (the reap
 * only ever sees other engines' files) and keeps tests that spawn real
 * children out of a developer's state directory.
 */
export function startRuntimePidRecord(): void {
  if (own) return
  const owner: EngineIdentity = {
    pid: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
    bootAt: currentBootAt(),
  }
  // The start time is in the name so a later engine handed the same pid gets a
  // file of its own instead of overwriting this one.
  own = { file: path.join(runtimePidDir(), `${owner.pid}-${owner.startedAt}.json`), owner }
}

/**
 * Record a spawned runtime child. Returns the function that forgets it, to call
 * when the child closes. A no-op before `startRuntimePidRecord`, or without a pid
 * (the spawn failed).
 */
export function recordRuntimePid(pid: number | undefined, command?: string): () => void {
  if (!own || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return noop
  const entry: RuntimePidEntry = { pid, startedAt: Date.now(), ...(command ? { command } : {}) }
  children.set(pid, entry)
  flush()
  return () => {
    // Only this entry: if the pid was reissued to a newer child in between,
    // that child's record stays.
    if (children.get(pid) !== entry) return
    children.delete(pid)
    flush()
  }
}

function flush(): void {
  if (!own) return
  const { file, owner } = own
  try {
    if (children.size === 0) {
      // Nothing left to reap: no file, so a clean shutdown leaves no trace.
      rmSync(file, { force: true })
      return
    }
    mkdirSync(path.dirname(file), { recursive: true })
    const body = JSON.stringify({ owner, children: [...children.values()] } satisfies RecordFile)
    // Write then rename, so an engine killed mid-write leaves the previous
    // complete file rather than a torn one the reap would have to discard.
    try {
      writeFileSync(`${file}.tmp`, body, 'utf8')
      renameSync(`${file}.tmp`, file)
    } catch {
      // Windows refuses the rename while another engine's reap has the file
      // open; a direct write is still better than no record.
      writeFileSync(file, body, 'utf8')
    }
  } catch {
    /* best effort */
  }
}

function parseRecord(raw: unknown): RecordFile | null {
  if (!raw || typeof raw !== 'object') return null
  const { owner, children: list } = raw as Partial<RecordFile>
  if (
    !owner ||
    typeof owner !== 'object' ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.startedAt !== 'number' ||
    typeof owner.bootAt !== 'number' ||
    !Array.isArray(list)
  ) {
    return null
  }
  const valid = list.filter(
    (e): e is RuntimePidEntry =>
      !!e &&
      typeof e === 'object' &&
      Number.isInteger((e as RuntimePidEntry).pid) &&
      (e as RuntimePidEntry).pid > 0 &&
      typeof (e as RuntimePidEntry).startedAt === 'number',
  )
  return { owner, children: valid }
}

/** Every record file but this engine's own, parsed (null when unreadable). */
function readOtherEngines(): { file: string; record: RecordFile | null }[] {
  let names: string[]
  try {
    names = readdirSync(runtimePidDir())
  } catch {
    return []
  }
  const out: { file: string; record: RecordFile | null }[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(runtimePidDir(), name)
    if (own && file === own.file) continue
    let record: RecordFile | null = null
    try {
      record = parseRecord(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      record = null
    }
    out.push({ file, record })
  }
  return out
}

function removeRecord(file: string): void {
  try {
    rmSync(file, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Whether the engine that wrote a file is still running.
 *
 * Errs towards YES: a wrong yes leaves an orphan running (the state before this
 * record existed), a wrong no kills a live engine's agent runs.
 */
function engineStillRunning(owner: EngineIdentity, probe: StartTimes): boolean {
  // Our own pid in a file that is not ours: a previous engine that held the same
  // number, now certainly gone.
  if (owner.pid === process.pid) return false
  if (!isAlive(owner.pid)) return false
  // The pid is held and nothing can say by whom. Assume the engine.
  if (!probe.ok) return true
  const startedAt = probe.times.get(owner.pid)
  return startedAt !== undefined && Math.abs(startedAt - owner.startedAt) <= START_TIME_SLACK_MS
}

export interface RuntimeReapReport {
  killed: number
  /** Dropped UNSIGNALLED as no longer trustworthy: recorded under a different
   *  boot, too old, or the pid now runs a process that started after our record. */
  expired: number
  /** Alive but NOT signalled, because this host could not report when the
   *  process holding the pid started. Counted so the log shows the gap. */
  unverified: number
  /** Files left alone because the engine that wrote them is still running. */
  liveEngines: number
}

export interface RuntimeReapDeps {
  /** Kills one verified child with its descendants. */
  kill?: (pid: number) => void
  /** Test seam for the start-time probe. */
  startTimes?: (pids: readonly number[]) => StartTimes
}

const killOrphanTree = (pid: number): void => killProcessTreeByPid(pid, { group: true })

/**
 * Kill the runtime children of every engine that is no longer running, then
 * drop their files.
 *
 * Called once at boot, BEFORE board reconciliation releases any task and before
 * this engine can spawn anything.
 */
export function reapOrphanedRuntimeChildren(deps: RuntimeReapDeps = {}): RuntimeReapReport {
  const kill = deps.kill ?? killOrphanTree
  const report: RuntimeReapReport = { killed: 0, expired: 0, unverified: 0, liveEngines: 0 }
  const files = readOtherEngines()
  if (files.length === 0) return report

  const now = Date.now()
  const bootAt = currentBootAt()
  const trusted = (e: RuntimePidEntry): boolean => now - e.startedAt <= MAX_TRUSTED_AGE_MS

  // ONE probe for the whole reap, over live pids only (see `processStartTimes`):
  // the engines that might still be running, and the children worth asking about.
  const candidates = new Set<number>()
  for (const { record } of files) {
    if (!record || record.owner.bootAt !== bootAt) continue
    if (record.owner.pid !== process.pid && isAlive(record.owner.pid)) {
      candidates.add(record.owner.pid)
    }
    for (const child of record.children) {
      if (trusted(child) && isAlive(child.pid)) candidates.add(child.pid)
    }
  }
  const probe = (deps.startTimes ?? processStartTimes)([...candidates])

  for (const { file, record } of files) {
    if (!record) {
      removeRecord(file)
      continue
    }
    // A DIFFERENT BOOT: every child died with it, and the numbers have been
    // handed out again. Nothing to signal.
    if (record.owner.bootAt !== bootAt) {
      report.expired += record.children.length
      removeRecord(file)
      continue
    }
    if (engineStillRunning(record.owner, probe)) {
      report.liveEngines += 1
      continue
    }
    for (const child of record.children) {
      if (!trusted(child)) {
        report.expired += 1
        continue
      }
      // Never this process or the one that launched it, whatever a record says.
      if (child.pid === process.pid || child.pid === process.ppid) {
        report.expired += 1
        continue
      }
      // Liveness proves a process EXISTS, not that it is ours: a recycled pid is
      // alive by definition. A cheap early exit, not a safety check.
      if (!isAlive(child.pid)) continue
      if (!probe.ok) {
        report.unverified += 1
        continue
      }
      // A recycled pid started AFTER we recorded the original; ours started just
      // before. No answer for a pid that was alive a moment ago means it is gone.
      const startedAt = probe.times.get(child.pid)
      if (startedAt === undefined || startedAt > child.startedAt + START_TIME_SLACK_MS) {
        report.expired += 1
        continue
      }
      try {
        kill(child.pid)
        report.killed += 1
      } catch {
        /* best effort: one stubborn child must not stop the rest */
      }
    }
    removeRecord(file)
  }
  return report
}

/** Forget this engine's file and children, so a test can arm the record again. */
export function __resetRuntimePidRecordForTests(): void {
  own = null
  children.clear()
}
